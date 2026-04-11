/**
 * Task Scheduler — manages user-defined scheduled tasks (CRON-like).
 *
 * Supports 3 schedule modes:
 *   - once:     Run once at a specific date/time, then auto-disable
 *   - weekly:   Run on selected days-of-week every week
 *   - specific: Run on specific MM-DD dates (once or yearly repeat)
 *
 * Uses TZ env var for timezone-aware cron scheduling (Docker-friendly).
 */

import cron from 'node-cron';
import { query, execute } from './db.js';
import { redfishClient } from './redfish-client.js';
import logger from './logger.js';

// Detect timezone: prefer TZ env var (Docker), fallback to system, then Asia/Jakarta
const SERVER_TIMEZONE = process.env.TZ
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || 'Asia/Jakarta';

class TaskScheduler {
  constructor() {
    /** @type {Map<number, import('node-cron').ScheduledTask>} */
    this.jobs = new Map();
    this.isStarted = false;
  }

  async start() {
    if (this.isStarted) return;
    this.isStarted = true;
    try {
      logger.info(`📅 Task Scheduler timezone: ${SERVER_TIMEZONE}`);
      await this.loadSchedules();
      logger.info(`📅 Task Scheduler started — ${this.jobs.size} active job(s)`);
    } catch (err) {
      logger.error({ err: err.message }, 'Task Scheduler failed to start');
    }
  }

  stop() {
    for (const [, job] of this.jobs) job.stop();
    this.jobs.clear();
    this.isStarted = false;
    logger.info('📅 Task Scheduler stopped');
  }

  async reload() {
    for (const [, job] of this.jobs) job.stop();
    this.jobs.clear();
    await this.loadSchedules();
    logger.info(`📅 Task Scheduler reloaded — ${this.jobs.size} active job(s)`);
  }

  /**
   * Load enabled schedules with their child data and register cron jobs.
   */
  async loadSchedules() {
    let schedules;
    try {
      schedules = await query('SELECT * FROM schedules WHERE is_enabled = $1', [true]);
    } catch {
      schedules = await query('SELECT * FROM schedules WHERE is_enabled = 1', []);
    }

    for (const schedule of schedules) {
      // Load child data based on mode
      if (schedule.schedule_mode === 'weekly') {
        const days = await query('SELECT day_of_week FROM schedule_days WHERE schedule_id = $1 ORDER BY day_of_week', [schedule.id]);
        schedule._days = days.map(d => d.day_of_week);
      } else if (schedule.schedule_mode === 'specific') {
        const dates = await query('SELECT month, day FROM schedule_dates WHERE schedule_id = $1 ORDER BY month, day', [schedule.id]);
        schedule._dates = dates.map(d => ({ month: d.month, day: d.day }));
      }

      this.registerJob(schedule);
    }
  }

  /**
   * Build cron expression based on schedule mode.
   */
  buildCronExpression(schedule) {
    const [hour, minute] = schedule.schedule_time.split(':');
    const m = parseInt(minute);
    const h = parseInt(hour);

    switch (schedule.schedule_mode) {
      case 'once': {
        if (!schedule.schedule_date) return `${m} ${h} * * *`;
        const [, month, day] = schedule.schedule_date.split('-');
        return `${m} ${h} ${parseInt(day)} ${parseInt(month)} *`;
      }

      case 'weekly': {
        const days = schedule._days || [];
        if (days.length === 0) return null;
        return `${m} ${h} * * ${days.join(',')}`;
      }

      case 'specific': {
        // Run daily at HH:MM, callback checks if today matches a selected date
        return `${m} ${h} * * *`;
      }

      default:
        return `${m} ${h} * * *`;
    }
  }

  /**
   * Register a cron job for a schedule.
   */
  registerJob(schedule) {
    try {
      const cronExpr = this.buildCronExpression(schedule);
      if (!cronExpr || !cron.validate(cronExpr)) {
        logger.warn({ id: schedule.id, cronExpr }, 'Invalid cron expression — skipping');
        return;
      }

      const job = cron.schedule(cronExpr, async () => {
        // For specific mode, check if today matches any selected date
        if (schedule.schedule_mode === 'specific') {
          const now = new Date();
          const todayMonth = now.getMonth() + 1;
          const todayDay = now.getDate();
          const dates = schedule._dates || [];
          const match = dates.find(d => d.month === todayMonth && d.day === todayDay);

          if (!match) {
            return; // Not a matching date — skip silently
          }

          logger.info({ id: schedule.id, name: schedule.name, date: `${todayMonth}-${todayDay}` },
            '⏰ Specific date matched! Executing...');
        } else {
          logger.info({ id: schedule.id, name: schedule.name }, '⏰ Cron triggered! Executing...');
        }

        await this.executeSchedule(schedule);
      }, { timezone: SERVER_TIMEZONE });

      this.jobs.set(schedule.id, job);

      const modeInfo = schedule.schedule_mode === 'weekly'
        ? `days=[${(schedule._days || []).join(',')}]`
        : schedule.schedule_mode === 'specific'
          ? `dates=${(schedule._dates || []).length} (${schedule.specific_repeat ? 'repeat' : 'once'})`
          : `date=${schedule.schedule_date || 'today'}`;

      logger.info({
        id: schedule.id, name: schedule.name, cronExpr,
        mode: schedule.schedule_mode, modeInfo, timezone: SERVER_TIMEZONE
      }, '✅ Registered schedule job');
    } catch (err) {
      logger.error({ err: err.message, id: schedule.id }, 'Failed to register schedule job');
    }
  }

  /**
   * Execute a scheduled task.
   */
  async executeSchedule(schedule) {
    const startTime = Date.now();
    let result = 'success';
    let resultMessage = '';

    try {
      logger.info({ id: schedule.id, name: schedule.name, type: schedule.type, action: schedule.action },
        '🚀 Executing scheduled task');

      if (schedule.type === 'power') {
        if (schedule.action === 'on') {
          const resp = await redfishClient.powerOn();
          resultMessage = resp.message || 'Power ON executed';
        } else if (schedule.action === 'off') {
          const resp = await redfishClient.powerOff(false);
          resultMessage = resp.message || 'Power OFF executed';
        } else {
          throw new Error(`Unknown power action: ${schedule.action}`);
        }
      } else if (schedule.type === 'redfish') {
        const resp = await redfishClient.executeRacadm(schedule.action);
        resultMessage = resp.message || resp.data?.output || 'Command executed';
      } else {
        throw new Error(`Unknown schedule type: ${schedule.type}`);
      }

      result = 'success';
      logger.info({ id: schedule.id, elapsed: Date.now() - startTime }, `✅ ${resultMessage}`);
    } catch (err) {
      result = 'error';
      resultMessage = err.message;
      logger.error({ err: err.message, id: schedule.id }, '❌ Schedule execution failed');
    }

    // Update last_run_at and last_result
    try {
      await execute(
        'UPDATE schedules SET last_run_at = CURRENT_TIMESTAMP, last_result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [`${result}: ${resultMessage}`, schedule.id]
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to update schedule last_run');
    }

    // Auto-disable logic per mode
    await this.handlePostExecution(schedule);
  }

  /**
   * Handle post-execution: auto-disable for once mode,
   * date removal for specific-once mode.
   */
  async handlePostExecution(schedule) {
    try {
      if (schedule.schedule_mode === 'once') {
        // Once mode: always disable after execution
        await this.disableSchedule(schedule.id);
        logger.info({ id: schedule.id }, '🔒 Once-only schedule disabled after execution');
      }

      if (schedule.schedule_mode === 'specific' && !schedule.specific_repeat && schedule.specific_repeat !== 1) {
        // Specific-once: check if there are remaining future dates
        const now = new Date();
        const todayMonth = now.getMonth() + 1;
        const todayDay = now.getDate();

        // Remove today's date from the table
        await execute(
          'DELETE FROM schedule_dates WHERE schedule_id = $1 AND month = $2 AND day = $3',
          [schedule.id, todayMonth, todayDay]
        );

        // Check remaining future dates
        const remaining = await query(
          'SELECT month, day FROM schedule_dates WHERE schedule_id = $1',
          [schedule.id]
        );

        // Filter to only future dates
        const futureDates = remaining.filter(d => {
          if (d.month > todayMonth) return true;
          if (d.month === todayMonth && d.day > todayDay) return true;
          return false;
        });

        if (futureDates.length === 0) {
          await this.disableSchedule(schedule.id);
          logger.info({ id: schedule.id }, '🔒 Specific-once schedule disabled — no future dates remain');
        } else {
          logger.info({ id: schedule.id, remaining: futureDates.length }, '📋 Specific-once: dates remaining');
        }
      }
    } catch (err) {
      logger.error({ err: err.message, id: schedule.id }, 'Post-execution handler error');
    }
  }

  /**
   * Disable a schedule and remove its cron job.
   */
  async disableSchedule(id) {
    await execute(
      'UPDATE schedules SET is_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [false, id]
    );
    const job = this.jobs.get(id);
    if (job) { job.stop(); this.jobs.delete(id); }
  }

  getActiveJobIds() {
    return Array.from(this.jobs.keys());
  }
}

const taskScheduler = new TaskScheduler();
export default taskScheduler;
