/**
 * Alert Scheduler — polls iDRAC via Python API and sends WhatsApp alerts.
 */

import cron from 'node-cron';
import { redfishClient } from './redfish-client.js';
import whatsappService from './baileys.js';
import { execute as dbExecute } from './db.js';
import config from '../config.js';
import logger from './logger.js';

class AlertScheduler {
  constructor() {
    this.cache = {
      lastPowerState: null,
      lastHealth: null,
      knownLogIds: new Set(),   // Track all known SEL entry IDs
      isFirstPoll: true,        // Skip alert flood on first poll
      lastTemps: {},
    };
    this.job = null;
    this.isRunning = false;
  }

  /**
   * Start the polling scheduler.
   */
  start() {
    if (!config.alert.enabled) {
      logger.info('Alert system is disabled (ALERT_ENABLED=false)');
      return;
    }

    const interval = config.alert.pollInterval;
    // Use cron expression for seconds-based interval
    const cronExpr = `*/${interval} * * * * *`;

    this.job = cron.schedule(cronExpr, async () => {
      if (this.isRunning) return; // Prevent overlapping polls
      this.isRunning = true;

      try {
        await this.poll();
      } catch (err) {
        logger.error({ err: err.message }, 'Alert poll error');
      } finally {
        this.isRunning = false;
      }
    });

    logger.info(`🔔 Alert scheduler started (every ${interval}s)`);
  }

  /**
   * Stop the scheduler.
   */
  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
      logger.info('Alert scheduler stopped');
    }
  }

  /**
   * Poll iDRAC and check for alert conditions.
   */
  async poll() {
    let system, thermal, latestLogs;

    try {
      [system, thermal, latestLogs] = await Promise.all([
        redfishClient.getSystem().then((r) => r.data),
        redfishClient.getThermal().then((r) => r.data),
        redfishClient.getLatestLogs(20).then((r) => r.data),
      ]);
    } catch (err) {
      // iDRAC unreachable — don't spam alerts
      logger.debug({ err: err.message }, 'Alert poll — iDRAC unreachable');
      return;
    }

    // ── 1. Power State Change ────────────────────
    if (
      this.cache.lastPowerState !== null &&
      system.power_state !== this.cache.lastPowerState
    ) {
      const icon = system.power_state === 'On' ? '✅' : '🔴';
      await this.sendAlert(
        'power_change',
        [
          `⚡ *Power State Changed*`,
          ``,
          `${this.cache.lastPowerState} → ${icon} *${system.power_state}*`,
        ].join('\n')
      );
    }

    // ── 2. Health Degradation ────────────────────
    if (
      this.cache.lastHealth === 'OK' &&
      system.health !== 'OK'
    ) {
      await this.sendAlert(
        'health',
        [
          `🚨 *Health Degraded*`,
          ``,
          `Status: ⚠️ *${system.health}*`,
          `Rollup: ${system.health_rollup}`,
          ``,
          `Periksa dashboard untuk detail lebih lanjut.`,
        ].join('\n')
      );
    }

    // ── 3. Temperature Spike ────────────────────
    const threshold = config.alert.tempThreshold;
    for (const temp of thermal.temperatures || []) {
      if (temp.reading_celsius > threshold) {
        const tempKey = temp.name;
        const lastTemp = this.cache.lastTemps[tempKey];

        // Only alert once per sensor (until it drops below threshold)
        if (!lastTemp || lastTemp <= threshold) {
          await this.sendAlert(
            'temp',
            [
              `🌡️ *Temperature Alert*`,
              ``,
              `Sensor: *${temp.name}*`,
              `Current: 🔴 *${temp.reading_celsius}°C*`,
              `Threshold: ${threshold}°C`,
              ``,
              `⚠️ Suhu melebihi batas! Periksa cooling system.`,
            ].join('\n')
          );
        }
      }
    }

    // ── 4. New SEL Entries (Real-time Event Log) ─
    const latestEntries = latestLogs.entries || [];
    if (latestEntries.length > 0) {
      if (this.cache.isFirstPoll) {
        // First poll — seed known IDs without sending alerts
        for (const entry of latestEntries) {
          this.cache.knownLogIds.add(entry.id);
        }
        this.cache.isFirstPoll = false;
        logger.info(
          `📋 SEL baseline seeded with ${latestEntries.length} entries (IDs: ${[...this.cache.knownLogIds].join(', ')})`
        );
      } else {
        // Find all NEW entries (entries with IDs we haven't seen before)
        const newEntries = latestEntries.filter(
          (entry) => !this.cache.knownLogIds.has(entry.id)
        );

        if (newEntries.length > 0) {
          logger.info(`📋 Detected ${newEntries.length} new SEL entries`);

          // Sort by created time ascending so we send oldest first
          newEntries.sort(
            (a, b) => new Date(a.created) - new Date(b.created)
          );

          // Send alerts for each new entry (cap at 10 to prevent spam)
          const entriesToSend = newEntries.slice(0, 10);
          for (const entry of entriesToSend) {
            const icon = this.getSeverityIcon(entry.severity);
            const sensorInfo = entry.sensor_type
              ? `\nSensor: ${entry.sensor_type}`
              : '';
            await this.sendAlert(
              'sel',
              [
                `${icon} *New Event Log*`,
                ``,
                `Severity: *${entry.severity}*`,
                `Message: ${entry.message}${sensorInfo}`,
                `ID: ${entry.message_id}`,
                `Time: ${entry.created}`,
              ].join('\n')
            );
          }

          // If there are more entries than the cap, send a summary
          if (newEntries.length > 10) {
            await this.sendAlert(
              'sel_overflow',
              [
                `📋 *Event Log Overflow*`,
                ``,
                `${newEntries.length} event baru terdeteksi.`,
                `${newEntries.length - 10} event tambahan tidak ditampilkan.`,
                ``,
                `Periksa dashboard untuk melihat semua event.`,
              ].join('\n')
            );
          }

          // Add all new IDs to known set
          for (const entry of newEntries) {
            this.cache.knownLogIds.add(entry.id);
          }
        }
      }

      // Keep known IDs set from growing unboundedly (keep latest 100)
      if (this.cache.knownLogIds.size > 100) {
        const allIds = [...this.cache.knownLogIds];
        this.cache.knownLogIds = new Set(allIds.slice(-100));
      }
    }

    // ── Update cache ────────────────────────────
    this.cache.lastPowerState = system.power_state;
    this.cache.lastHealth = system.health;
    this.cache.lastTemps = {};
    for (const temp of thermal.temperatures || []) {
      this.cache.lastTemps[temp.name] = temp.reading_celsius;
    }
  }

  /**
   * Map SEL severity to a descriptive icon for WhatsApp messages.
   */
  getSeverityIcon(severity) {
    const icons = {
      Critical: '🔴',
      Warning: '⚠️',
      OK: '✅',
    };
    return icons[severity] || '📋';
  }

  /**
   * Send an alert via WhatsApp and log to database.
   */
  async sendAlert(type, message) {
    logger.warn({ type }, `Alert triggered: ${type}`);

    // Send via WhatsApp
    if (whatsappService.status === 'connected') {
      await whatsappService.sendAlert(message);
    } else {
      logger.warn('Alert cannot be sent — WhatsApp not connected');
    }

    // Log to database
    try {
      const numbers = config.whatsapp.allowedNumbers.join(',');
      await dbExecute(
        `INSERT INTO alert_logs (alert_type, message, sent_to)
         VALUES ($1, $2, $3)`,
        [type, message, numbers]
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to log alert');
    }
  }
}

// Singleton
const alertScheduler = new AlertScheduler();
export default alertScheduler;
