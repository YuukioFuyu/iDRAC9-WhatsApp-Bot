/**
 * Baileys WhatsApp Service — manages WA connection, QR, messages.
 *
 * CRITICAL FIX: statusCode 405 — connection never generates QR.
 *
 * Root cause #1: Fake baileysLogger object broke Baileys internals.
 * Baileys calls logger.child() extensively, and the child must be a
 * full Pino-compatible instance. Our no-op object caused silent failures
 * in WebSocket initialization → connection rejected → 405.
 *
 * Root cause #2: Custom browser identifier ['iDRAC Bot', ...] was
 * rejected by WhatsApp servers. Changed to standard Ubuntu/Chrome.
 *
 * Fix: Use real Pino instance with level='silent' for production,
 * 'warn' for development (so we can actually see Baileys output).
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';
import config from '../config.js';
import logger from './logger.js';
import { parseAndExecute } from './command-parser.js';
import rateLimiter from '../middleware/rate-limit.js';
import { execute as dbExecute } from './db.js';


// REAL Pino instance for Baileys — critical for .child() compatibility
const baileysLogger = pino({
  level: config.isDev ? 'warn' : 'silent',
});

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.qrCode = null;
    this.status = 'disconnected'; // disconnected | waiting_scan | connecting | connected
    this.linkedNumber = null;
    this.linkedName = null;
    this.retryCount = 0;
    this.maxRetries = 10;
    this.isConnecting = false; // Guard against double-connect
    this.reconnectTimer = null; // Track pending reconnect timer
    this.chatHistory = []; // In-memory recent history (for dashboard)
    this.maxHistory = 100;
  }

  /**
   * Start or restart the WhatsApp connection.
   */
  async connect() {
    // Guard: prevent double-connect
    if (this.isConnecting) {
      logger.warn('WhatsApp connect() called while already connecting — skipping');
      return;
    }
    if (this.status === 'connected') {
      logger.info('WhatsApp already connected');
      return;
    }

    this.isConnecting = true;

    // Cancel any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const sessionDir = config.whatsapp.sessionPath;

    // Ensure session directory exists
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    try {
      // Destroy previous socket cleanly
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.ws?.close();
        } catch {
          // Ignore cleanup errors
        }
        this.sock = null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      // CRITICAL: always fetch latest WA version — old versions are rejected
      const { version } = await fetchLatestBaileysVersion();
      logger.info({ version }, '📲 Using WhatsApp version');

      this.status = 'connecting';

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        printQRInTerminal: false, // QR goes to web, NOT terminal
        browser: Browsers.ubuntu('Chrome'), // Exact same as Baileys default
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
      });

      // ── Connection updates ───────────────────────
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code received
        if (qr) {
          this.qrCode = qr;
          this.status = 'waiting_scan';
          this.emit('qr', qr);
          logger.info('New QR code generated — waiting for scan');
        }

        // Connection opened
        if (connection === 'open') {
          this.status = 'connected';
          this.qrCode = null;
          this.retryCount = 0;
          this.isConnecting = false;

          // Get linked number info
          const me = this.sock?.user;
          if (me) {
            this.linkedNumber = me.id.split(':')[0].split('@')[0];
            this.linkedName = me.name || '';
          }

          this.emit('connected', {
            number: this.linkedNumber,
            name: this.linkedName,
          });
          logger.info(
            { number: this.linkedNumber, name: this.linkedName },
            '✅ WhatsApp connected'
          );
        }

        // Connection closed
        if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;
          const errorMessage =
            lastDisconnect?.error?.message || 'Unknown error';
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut;

          this.linkedNumber = null;
          this.isConnecting = false;

          // Log the actual error for debugging
          logger.warn(
            { statusCode, errorMessage, retryCount: this.retryCount },
            `WhatsApp connection closed: ${errorMessage}`
          );

          if (shouldReconnect && this.retryCount < this.maxRetries) {
            this.retryCount++;
            const delay = Math.min(2000 * Math.pow(1.5, this.retryCount - 1), 30000);

            // Emit 'reconnecting' NOT 'disconnected' — keeps SSE alive
            this.status = 'connecting';
            this.emit('reconnecting', {
              retryCount: this.retryCount,
              delay,
              statusCode,
              errorMessage,
            });

            logger.warn(
              { retryCount: this.retryCount, delay, statusCode },
              'WhatsApp disconnected — reconnecting...'
            );

            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.connect();
            }, delay);

          } else if (!shouldReconnect) {
            // User logged out (or 401 Unauthorized)
            this.status = 'disconnected';
            this.qrCode = null;
            await this.clearSessionFiles(); // Actually wipe the files!
            logger.info('WhatsApp logged out — session cleared');
            this.emit('disconnected', { reason: 'logged_out' });

          } else {
            // Max retries exceeded
            this.status = 'disconnected';
            this.qrCode = null;
            logger.error('WhatsApp max retries exceeded');
            this.emit('disconnected', { reason: 'max_retries' });
          }
        }
      });

      // ── Credentials update ───────────────────────
      this.sock.ev.on('creds.update', saveCreds);

      // ── Message handling ─────────────────────────
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          await this.handleMessage(msg);
        }
      });
    } catch (err) {
      this.isConnecting = false;
      this.status = 'disconnected';
      logger.error({ err: err.message }, 'WhatsApp connect error');
      throw err;
    }
  }

  /**
   * Handle incoming WhatsApp message.
   */
  async handleMessage(msg) {
    // Ignore status broadcasts, own messages, and protocol messages
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (msg.key.fromMe) return;
    if (!msg.message) return;

    // Extract text from various message types
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    // Extract sender number (participant used for groups, remoteJid for direct)
    const rawSender = msg.key.participant || msg.key.remoteJid;
    const sender = rawSender.replace('@s.whatsapp.net', ''); // Removes suffix if standard phone number

    // Check whitelist (empty whitelist = allow all)
    const allowedNumbers = config.whatsapp.allowedNumbers;
    const isWhitelisted = allowedNumbers.length === 0 || allowedNumbers.some(num => {
      // Match exact, or match LID (allows user to write LID in .env with or without @lid)
      return sender === num || sender === `${num}@lid` || sender.replace('@lid', '') === num;
    });

    if (!isWhitelisted) {
      logger.warn({ sender: rawSender }, 'Message from non-whitelisted number');
      return;
    }

    // Rate limit check
    const rateCheck = rateLimiter.check(sender);
    if (!rateCheck.allowed) {
      await this.sendMessage(
        msg.key.remoteJid,
        `⏳ Rate limit tercapai. Coba lagi dalam ${rateCheck.resetIn} detik.`
      );
      this.logCommand(sender, text, 'Rate limited', 'rate_limited', 0);
      return;
    }

    // Parse and execute command
    const startTime = Date.now();
    const result = await parseAndExecute(text);
    const elapsed = Date.now() - startTime;

    if (result === null) {
      return;
    }

    // Send response
    await this.sendMessage(msg.key.remoteJid, result.response);

    // Log to history and database
    this.addToHistory(sender, text, result.response);
    this.logCommand(sender, result.command, result.response, 'success', elapsed);

    logger.info(
      { sender, command: result.command, elapsed },
      'WhatsApp command processed'
    );
  }

  /**
   * Send a text message.
   */
  async sendMessage(jid, text) {
    if (!this.sock || this.status !== 'connected') {
      logger.warn('Cannot send message — WhatsApp not connected');
      return false;
    }

    try {
      await this.sock.sendMessage(jid, { text });
      return true;
    } catch (err) {
      logger.error({ err: err.message, jid }, 'Failed to send WhatsApp message');
      return false;
    }
  }

  /**
   * Send an alert to all whitelisted numbers.
   */
  async sendAlert(text) {
    const numbers = config.whatsapp.allowedNumbers;
    if (numbers.length === 0) {
      logger.warn('No whitelisted numbers for alert');
      return;
    }

    for (const number of numbers) {
      const jid = `${number}@s.whatsapp.net`;
      await this.sendMessage(jid, text);
    }
  }

  /**
   * Request a pairing code (alternative to QR).
   * @param {string} phoneNumber — e.g., "628xxxxxxxxxx" (no +, spaces, or dashes)
   */
  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new Error('WhatsApp socket not initialized — connect first');
    }

    // Wait for socket to be ready (not immediately after connect)
    if (this.status === 'connecting') {
      await new Promise((resolve) => {
        const checkReady = () => {
          if (this.status !== 'connecting') {
            resolve();
          } else {
            setTimeout(checkReady, 500);
          }
        };
        setTimeout(checkReady, 2000);
      });
    }

    try {
      const code = await this.sock.requestPairingCode(phoneNumber);
      logger.info({ phoneNumber }, 'Pairing code requested');
      return code;
    } catch (err) {
      logger.error({ err: err.message, phoneNumber }, 'Pairing code request failed');
      throw err;
    }
  }

  /**
   * Graceful disconnect — close WebSocket WITHOUT logging out.
   * Session files are PRESERVED so the bot auto-reconnects on restart.
   * Used by: SIGTERM handler (docker compose down), server restart.
   */
  async disconnect() {
    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        // Just close the WebSocket — do NOT call sock.logout()
        this.sock.ws?.close();
      } catch {
        // Ignore errors during disconnect
      }
      this.sock = null;
    }

    this.status = 'disconnected';
    this.linkedNumber = null;
    this.linkedName = null;
    this.qrCode = null;
    this.retryCount = 0;
    this.isConnecting = false;
    this.emit('disconnected', { reason: 'graceful' });
    logger.info('WhatsApp disconnected gracefully (session preserved)');
  }

  /**
   * Full logout — logout from WhatsApp server AND wipe session files.
   * Session is completely destroyed, user must re-scan QR to reconnect.
   * Used by: user clicking "Disconnect" button on dashboard.
   */
  async logout() {
    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout(); // Tell WhatsApp server to deregister
      } catch {
        // Ignore errors during logout
      }
      this.sock = null;
    }

    // Wipe session files so next connect starts fresh
    await this.clearSessionFiles();

    this.status = 'disconnected';
    this.linkedNumber = null;
    this.linkedName = null;
    this.qrCode = null;
    this.retryCount = 0;
    this.isConnecting = false;
    this.emit('disconnected', { reason: 'user' });
    logger.info('WhatsApp logged out and session wiped');
  }

  /**
   * Reset session — wipe all auth data and start fresh.
   * Use this when session data is corrupt from failed pairing attempts.
   */
  async resetSession() {
    // Disconnect first
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.ws?.close();
      } catch {
        // Ignore
      }
      this.sock = null;
    }

    // Wipe session directory contents
    await this.clearSessionFiles();

    // Reset all state
    this.status = 'disconnected';
    this.linkedNumber = null;
    this.linkedName = null;
    this.qrCode = null;
    this.retryCount = 0;
    this.isConnecting = false;
    this.emit('disconnected', { reason: 'reset' });
    logger.info('WhatsApp session reset — ready for fresh pairing');
  }

  /**
   * Helper to delete all files in session directory without deleting the directory itself.
   * This prevents "EBUSY" errors on Windows Docker mounts.
   */
  async clearSessionFiles() {
    const sessionDir = config.whatsapp.sessionPath;
    const { readdirSync, rmSync } = await import('fs');
    try {
      if (existsSync(sessionDir)) {
        const files = readdirSync(sessionDir);
        for (const file of files) {
          try {
            rmSync(`${sessionDir}/${file}`, { recursive: true, force: true });
          } catch (e) {
            // Ignore individual file lock errors
          }
        }
      }
      logger.info(`🗑️  Session data wiped: ${sessionDir}`);
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to wipe session directory');
    }
  }

  /**
   * Get current connection status.
   */
  getStatus() {
    return {
      status: this.status,
      linkedNumber: this.linkedNumber,
      linkedName: this.linkedName,
      qrAvailable: !!this.qrCode,
      retryCount: this.retryCount,
    };
  }

  /**
   * Get recent chat history.
   */
  getChatHistory(limit = 50) {
    return this.chatHistory.slice(-limit);
  }

  // ── Internal helpers ─────────────────────────────

  addToHistory(sender, message, response) {
    const timestamp = new Date().toISOString();
    this.chatHistory.push(
      { type: 'in', sender, text: message, timestamp },
      { type: 'out', sender: 'BOT', text: response, timestamp },
    );
    if (this.chatHistory.length > this.maxHistory * 2) {
      this.chatHistory = this.chatHistory.slice(-this.maxHistory);
    }
  }

  async logCommand(sender, command, response, status, elapsed) {
    try {
      await dbExecute(
        `INSERT INTO command_logs (sender_number, command, response, status, response_time_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [sender, command, response?.substring(0, 1000), status, elapsed]
      );
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to log command to database');
    }
  }
}

// Singleton instance
const whatsappService = new WhatsAppService();
export default whatsappService;
