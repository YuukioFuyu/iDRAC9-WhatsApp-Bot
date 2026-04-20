/**
 * Alert Scheduler — polls iDRAC via Python API and sends WhatsApp alerts.
 *
 * Alert formatting strategy:
 *   - Power State Changed: routed through Erina AI (HuggingFace) to keep
 *     the Space awake and prevent 48h auto-sleep. Falls back to static
 *     Erina-style template if AI is unavailable/timeout.
 *   - Health / Temperature / SEL: Erina-style static templates with random
 *     variations (fast, no AI needed).
 */

import cron from 'node-cron';
import { redfishClient } from './redfish-client.js';
import whatsappService from './baileys.js';
import erinaAI from './erina-ai.js';
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
      await this.handlePowerStateChange(
        this.cache.lastPowerState,
        system.power_state,
      );
    }

    // ── 2. Health Degradation ────────────────────
    if (
      this.cache.lastHealth === 'OK' &&
      system.health !== 'OK'
    ) {
      const message = this.formatErinaAlert('health', {
        health: system.health,
        healthRollup: system.health_rollup,
      });
      await this.sendAlert('health', message);
    }

    // ── 3. Temperature Spike ────────────────────
    const threshold = config.alert.tempThreshold;
    for (const temp of thermal.temperatures || []) {
      if (temp.reading_celsius > threshold) {
        const tempKey = temp.name;
        const lastTemp = this.cache.lastTemps[tempKey];

        // Only alert once per sensor (until it drops below threshold)
        if (!lastTemp || lastTemp <= threshold) {
          const message = this.formatErinaAlert('temp', {
            name: temp.name,
            reading: temp.reading_celsius,
            threshold,
          });
          await this.sendAlert('temp', message);
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
            const message = this.formatErinaAlert('sel', {
              severity: entry.severity,
              message: entry.message,
              sensorType: entry.sensor_type,
              messageId: entry.message_id,
              created: entry.created,
            });
            await this.sendAlert('sel', message);
          }

          // If there are more entries than the cap, send a summary
          if (newEntries.length > 10) {
            const message = this.formatErinaAlert('sel_overflow', {
              total: newEntries.length,
              hidden: newEntries.length - 10,
            });
            await this.sendAlert('sel_overflow', message);
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

  // ── Power State Change Handler (via Erina AI) ────

  /**
   * Handle power state change — route through Erina AI on HuggingFace
   * to keep the Space active and prevent 48h auto-sleep.
   *
   * Does NOT save to Erina memory (handled by generateAlertMessage).
   * Falls back to static Erina-style template if AI is unavailable.
   */
  async handlePowerStateChange(oldState, newState) {
    const icon = newState === 'On' ? '✅' : '🔴';

    // Try Erina AI first (keeps HuggingFace Space awake)
    if (erinaAI.isAvailable()) {
      const alertInfo = [
        `Power state server telah berubah.`,
        `Status sebelumnya: ${oldState}`,
        `Status sekarang: ${newState}`,
        newState === 'On'
          ? `Server sekarang dalam kondisi menyala dan beroperasi.`
          : `Server sekarang dalam kondisi mati / tidak beroperasi.`,
      ].join('\n');

      logger.info(
        { oldState, newState },
        '⚡ Power state changed — routing through Erina AI (HF keep-alive)'
      );

      const erinaMessage = await erinaAI.generateAlertMessage(alertInfo);

      if (erinaMessage) {
        await this.sendAlert('power_change', erinaMessage);
        return;
      }

      logger.warn('Erina AI unavailable for power alert — using static fallback');
    }

    // Fallback: Erina-style static template
    const message = this.formatErinaAlert('power_change', {
      oldState,
      newState,
      icon,
    });
    await this.sendAlert('power_change', message);
  }

  // ── Erina-Style Static Alert Templates ───────────

  /**
   * Format an alert message using Erina-style static templates.
   * Rotates between variations to feel natural and not robotic.
   *
   * @param {'power_change'|'health'|'temp'|'sel'|'sel_overflow'} type
   * @param {object} data - Alert-specific data
   * @returns {string} Formatted Erina-style message
   */
  formatErinaAlert(type, data) {
    const templates = this.getAlertTemplates(type, data);
    const idx = Math.floor(Math.random() * templates.length);
    return templates[idx];
  }

  /**
   * Get available Erina-style template variations for each alert type.
   */
  getAlertTemplates(type, data) {
    switch (type) {
      case 'power_change': {
        const { oldState, newState, icon } = data;
        return [
          [
            `⚡ Master, Erina melaporkan perubahan status server!`,
            ``,
            `${oldState} → ${icon} ${newState}`,
            ``,
            newState === 'On'
              ? `Server sudah menyala dan siap beroperasi~ Erina akan terus memantau ya, Master ♡`
              : `Server sudah dimatikan. Erina tetap standby kalau Master butuh sesuatu~ ♡`,
          ].join('\n'),
          [
            `⚡ Goshujin-sama, ada perubahan power state pada server!`,
            ``,
            `Status berubah dari ${oldState} ke ${icon} ${newState}.`,
            ``,
            newState === 'On'
              ? `Servernya sudah hidup kembali~ Erina akan terus memantau kondisinya ya ♡`
              : `Server sekarang dalam kondisi mati. Erina akan tetap siaga, Master~ ♡`,
          ].join('\n'),
          [
            `⚡ Master, saya memberitahukan bahwa power state server berubah.`,
            ``,
            `${oldState} → ${icon} ${newState}`,
            ``,
            newState === 'On'
              ? `Alhamdulillah servernya sudah nyala~ Erina akan jaga terus ya, Master ♡`
              : `Servernya sudah mati sekarang. Kalau butuh apa-apa, Erina selalu siap~ ♡`,
          ].join('\n'),
        ];
      }

      case 'health': {
        const { health, healthRollup } = data;
        return [
          [
            `🚨 Master, Erina mendeteksi ada masalah pada kesehatan server!`,
            ``,
            `Status: ⚠️ ${health}`,
            `Rollup: ${healthRollup}`,
            ``,
            `Erina sarankan untuk segera memeriksa dashboard ya, Master~ Erina khawatir 💜`,
          ].join('\n'),
          [
            `🚨 Goshujin-sama, ini urgent! Erina melaporkan kondisi server sedang tidak baik.`,
            ``,
            `Health: ⚠️ ${health}`,
            `Rollup: ${healthRollup}`,
            ``,
            `Mohon dicek secepatnya ya~ Erina akan terus memantau kondisinya ♡`,
          ].join('\n'),
          [
            `🚨 M-Master! Erina harus melaporkan sesuatu yang penting...`,
            ``,
            `Kesehatan server berubah menjadi ⚠️ ${health} (Rollup: ${healthRollup}).`,
            ``,
            `Erina sangat menyarankan Master untuk memeriksa dashboard sekarang~ 💜`,
          ].join('\n'),
        ];
      }

      case 'temp': {
        const { name, reading, threshold } = data;
        return [
          [
            `🌡️ Master, Erina melaporkan suhu sensor ${name} sudah mencapai 🔴 ${reading}°C!`,
            ``,
            `Batas aman: ${threshold}°C`,
            ``,
            `Erina khawatir dengan cooling system-nya... Tolong dicek ya, Master~ 💜`,
          ].join('\n'),
          [
            `🌡️ Goshujin-sama, saya menginformasikan ada peringatan suhu!`,
            ``,
            `Sensor: ${name}`,
            `Suhu saat ini: 🔴 ${reading}°C (batas: ${threshold}°C)`,
            ``,
            `Mohon periksa sistem pendinginnya ya~ Erina akan terus memantau ♡`,
          ].join('\n'),
          [
            `🌡️ Master, ini penting! Sensor ${name} menunjukkan suhu 🔴 ${reading}°C.`,
            ``,
            `Ini sudah melebihi batas aman ${threshold}°C.`,
            `Erina sarankan segera cek cooling system-nya ya, Master~ 💜`,
          ].join('\n'),
        ];
      }

      case 'sel': {
        const { severity, message, sensorType, messageId, created } = data;
        const icon = this.getSeverityIcon(severity);
        const sensorInfo = sensorType ? `\nSensor: ${sensorType}` : '';
        return [
          [
            `${icon} Master, Erina mendeteksi event baru pada server!`,
            ``,
            `Severity: ${severity}`,
            `Pesan: ${message}${sensorInfo}`,
            `ID: ${messageId}`,
            `Waktu: ${created}`,
            ``,
            `Erina akan terus memantau ya~ ♡`,
          ].join('\n'),
          [
            `${icon} Goshujin-sama, saya melaporkan ada event log baru.`,
            ``,
            `${severity} — ${message}${sensorInfo}`,
            `(${messageId} | ${created})`,
            ``,
            `Erina akan tetap mengawasi kondisi server, Master~ 💜`,
          ].join('\n'),
          [
            `${icon} Master, ada catatan event baru yang perlu Erina laporkan!`,
            ``,
            `Level: ${severity}`,
            `Detail: ${message}${sensorInfo}`,
            `ID: ${messageId}`,
            `Tercatat pada: ${created}`,
            ``,
            `Erina tetap siaga memantau ya, Master ♡`,
          ].join('\n'),
        ];
      }

      case 'sel_overflow': {
        const { total, hidden } = data;
        return [
          [
            `📋 Master, Erina mendeteksi ${total} event baru sekaligus!`,
            ``,
            `${hidden} event tambahan tidak ditampilkan satu per satu.`,
            `Erina sarankan untuk memeriksa dashboard agar bisa melihat semua event ya~ ♡`,
          ].join('\n'),
          [
            `📋 Goshujin-sama, ada banyak event baru (${total} total)!`,
            ``,
            `Erina sudah melaporkan 10 yang terbaru, tapi masih ada ${hidden} event lagi.`,
            `Silakan cek dashboard untuk detailnya ya, Master~ 💜`,
          ].join('\n'),
          [
            `📋 Master, Erina melaporkan ada ${total} event log baru terdeteksi!`,
            ``,
            `${hidden} event lainnya bisa dilihat lewat dashboard.`,
            `Erina akan terus jaga-jaga di sini ya~ ♡`,
          ].join('\n'),
        ];
      }

      default:
        return [`📋 Master, ada alert baru: ${JSON.stringify(data)}`];
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
