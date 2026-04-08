/**
 * Baileys WhatsApp Service — manages WA connection, QR, messages.
 *
 * REDESIGNED: Full Erina AI integration with:
 * - User identity detection (pushName + LID + Master recognition)
 * - Intent classification (fuzzy keyword pre-fetch)
 * - Dynamic composing presence (typing indicator)
 * - Power action confirmation flow via Erina NLU
 * - Selective memory management
 * - Graceful fallback when Erina is offline
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
import { executeCommand, COMMANDS } from './command-parser.js';
import { classifyIntent } from './intent-classifier.js';
import { analyzeServerData } from './server-analyzer.js';
import erinaAI from './erina-ai.js';
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
    this.processedMsgIds = new Set(); // Dedup: prevent double-processing from phone+LID JIDs
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

          const erinaStatus = erinaAI.isAvailable() ? '💜 Erina AI active' : '⚠️ Erina AI disabled';
          logger.info(
            { number: this.linkedNumber, name: this.linkedName },
            `✅ WhatsApp connected — ${erinaStatus}`
          );

          // Warm up Erina Space in background (non-blocking)
          if (erinaAI.isAvailable()) {
            erinaAI.warmUp().catch(() => { /* already logged inside warmUp() */ });
          }
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

  // ══════════════════════════════════════════════════
  // MESSAGE HANDLER — Erina AI Integration
  // ══════════════════════════════════════════════════

  /**
   * Handle incoming WhatsApp message.
   * Routes through: Identity → Intent → Redfish/Erina → Response
   */
  async handleMessage(msg) {
    // Ignore status broadcasts, own messages, and protocol messages
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (msg.key.fromMe) return;
    if (!msg.message) return;

    // Dedup: WhatsApp multi-device can deliver the same message via
    // both phone JID and LID JID. Skip if we already processed this message ID.
    const msgId = msg.key.id;
    if (this.processedMsgIds.has(msgId)) {
      logger.debug({ msgId }, 'Skipping duplicate message (already processed)');
      return;
    }
    this.processedMsgIds.add(msgId);
    // Auto-cleanup after 60s to prevent memory leak
    setTimeout(() => this.processedMsgIds.delete(msgId), 60_000);

    // Extract text from various message types
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    // ── 1. Extract user identity ──────────────────
    const rawSender = msg.key.participant || msg.key.remoteJid;
    const senderLID = rawSender.replace('@s.whatsapp.net', '').replace('@lid', '');
    const pushName = msg.pushName || null;

    // Check whitelist (empty whitelist = allow all)
    const allowedNumbers = config.whatsapp.allowedNumbers;
    const isWhitelisted = allowedNumbers.length === 0 || allowedNumbers.some(num => {
      return senderLID === num || senderLID === `${num}@lid` || rawSender === `${num}@lid`
        || rawSender === `${num}@s.whatsapp.net` || num.replace('@lid', '') === senderLID;
    });

    if (!isWhitelisted) {
      logger.warn({ sender: rawSender, pushName }, 'Message from non-whitelisted number');
      return;
    }

    // Determine if sender is the master/owner
    const isOwner = allowedNumbers.some(num => {
      const clean = num.replace('@lid', '');
      return senderLID === clean;
    });

    const userName = pushName || (isOwner ? 'Master' : 'Tamu');

    // Rate limit check
    const rateCheck = rateLimiter.check(senderLID);
    if (!rateCheck.allowed) {
      await this.sendMessage(
        msg.key.remoteJid,
        `⏳ Rate limit tercapai. Coba lagi dalam ${rateCheck.resetIn} detik.`
      );
      this.logCommand(senderLID, text, 'Rate limited', 'rate_limited', 0);
      return;
    }

    const startTime = Date.now();

    // ── 2. Send composing presence (typing...) ────
    await this.sendPresence(msg.key.remoteJid, 'composing');

    try {
      // ── 3. Check for pending power confirmation ──
      const pendingAction = erinaAI.getPendingAction(senderLID);
      if (pendingAction) {
        await this.handlePowerConfirmation(msg, text, senderLID, userName, isOwner, pendingAction, startTime);
        return;
      }

      // ── 4. Classify intent ──────────────────────
      const intent = classifyIntent(text);
      logger.info({ sender: senderLID, pushName, intent: intent.type, command: intent.command }, 'Intent classified');

      let response;

      switch (intent.type) {
        case 'exact_command':
          response = await this.handleExactCommand(text, intent, userName, isOwner, senderLID);
          break;

        case 'server_hint':
          response = await this.handleServerHint(text, intent, userName, isOwner);
          break;

        case 'power_action':
          // Power ON is non-destructive — execute directly without confirmation
          if (intent.action === 'on') {
            response = await this.handlePowerOn(text, intent, userName, isOwner);
          } else {
            response = await this.handlePowerAction(text, intent, userName, isOwner, senderLID);
          }
          break;

        case 'chat':
        default:
          response = await this.handleCasualChat(text, userName, isOwner);
          break;
      }

      // ── 5. Send response ──────────────────────
      await this.sendPresence(msg.key.remoteJid, 'paused');
      await this.sendMessage(msg.key.remoteJid, response);

      const elapsed = Date.now() - startTime;
      this.addToHistory(senderLID, text, response);
      this.logCommand(senderLID, intent.command || 'chat', response, 'success', elapsed);

      logger.info(
        { sender: senderLID, pushName, intent: intent.type, command: intent.command, elapsed },
        'Message processed'
      );

    } catch (err) {
      await this.sendPresence(msg.key.remoteJid, 'paused');
      logger.error({ err: err.message, sender: senderLID }, 'Message handling error');

      await this.sendMessage(
        msg.key.remoteJid,
        `❌ Maaf, terjadi error saat memproses pesan.\n\n${err.message}`
      );
    }
  }

  // ── Handler: Exact Command ─────────────────────────

  /**
   * Handle exact command matches (backward compatible).
   * Fetches Redfish data → analyzes → wraps with Erina or falls back to static.
   */
  async handleExactCommand(text, intent, userName, isOwner, senderLID) {
    // Help command — always static (no need for AI)
    if (intent.command === 'help') {
      const result = await executeCommand('help');
      return result.fallbackText;
    }

    // Power commands — redirect to power confirmation flow (NEVER execute directly!)
    if (['on', 'off', 'restart', 'idrac_reset'].includes(intent.command)) {
      const actionMap = { on: 'on', off: 'off', restart: 'restart', idrac_reset: 'restart' };
      return this.handlePowerAction(text, {
        ...intent,
        action: actionMap[intent.command],
      }, userName, isOwner, senderLID);
    }

    // Data commands — fetch, analyze, wrap with Erina
    const result = await executeCommand(intent.command, intent.args);

    if (erinaAI.isAvailable() && result.data) {
      const analysis = analyzeServerData(result.data, result.type);
      const erinaResponse = await erinaAI.chat(text, {
        userName,
        isOwner,
        serverAnalysis: analysis,
      });

      if (erinaResponse) return erinaAI.stripMarkers(erinaResponse);
    }

    // Fallback to static response
    return result.fallbackText;
  }

  // ── Handler: Server Hint (Natural Language) ────────

  /**
   * Handle natural language server queries.
   * Pre-fetches Redfish data based on fuzzy keyword hint, then asks Erina.
   */
  async handleServerHint(text, intent, userName, isOwner) {
    let result;

    try {
      result = await executeCommand(intent.command);
    } catch (err) {
      logger.warn({ err: err.message, command: intent.command }, 'Server hint pre-fetch failed');
    }

    if (erinaAI.isAvailable()) {
      const analysis = result?.data ? analyzeServerData(result.data, result.type) : null;
      const erinaResponse = await erinaAI.chat(text, {
        userName,
        isOwner,
        serverAnalysis: analysis,
      });

      if (erinaResponse) return erinaAI.stripMarkers(erinaResponse);

      // Erina timeout but we have data — use Erina-personality fallback
      if (result?.fallbackText) {
        return erinaAI.getServerFallback(result.fallbackText, analysis);
      }
    }

    // Final fallback
    return result?.fallbackText || '💜 Maaf, Erina sedang sibuk dan belum bisa mengambil data server saat ini... Coba lagi nanti ya~ ♡';
  }

  // ── Handler: Power ON (Direct Execution, No Confirmation) ──

  /**
   * Handle power ON — execute directly since it's non-destructive.
   * Still wraps with Erina AI for natural response.
   */
  async handlePowerOn(text, intent, userName, isOwner) {
    // Execute power-on immediately
    const result = await executeCommand(intent.command, intent.args);

    if (erinaAI.isAvailable()) {
      // Let Erina wrap the result naturally
      const erinaResponse = await erinaAI.chat(
        `${text}\n\n[HASIL EKSEKUSI: Server berhasil dinyalakan. ${result.fallbackText}]`,
        { userName, isOwner }
      );

      if (erinaResponse) {
        const cleaned = erinaAI.stripMarkers(erinaResponse);
        // If Erina doesn't mention the result, append it
        if (!cleaned.toLowerCase().includes('nyala') && !cleaned.toLowerCase().includes('power on')) {
          return `${cleaned}\n\n${result.fallbackText}`;
        }
        return cleaned;
      }
    }

    return result.fallbackText;
  }

  // ── Handler: Power Action (Confirmation Flow — OFF/RESTART only) ──

  /**
   * Handle destructive power action requests — ask Erina for confirmation prompt.
   */
  async handlePowerAction(text, intent, userName, isOwner, senderLID) {
    // Set pending action FIRST — regardless of Erina availability
    erinaAI.setPendingAction(senderLID, intent.action, intent.command, intent.args);

    if (erinaAI.isAvailable()) {
      // Ask Erina to generate natural confirmation prompt
      const erinaResponse = await erinaAI.chat(text, {
        userName,
        isOwner,
        pendingAction: intent.action,
      });

      if (erinaResponse) {
        // Refresh pending action timer — countdown starts from when user SEES the confirmation,
        // not from when we started generating it (Erina AI takes ~2 min on CPU)
        erinaAI.setPendingAction(senderLID, intent.action, intent.command, intent.args);
        return erinaAI.stripMarkers(erinaResponse);
      }
    }

    // Fallback: Erina-personality confirmation prompt (NEVER execute directly!)
    return erinaAI.getPowerConfirmFallback(intent.action, isOwner);
  }

  /**
   * Handle the user's response to a power confirmation prompt.
   */
  async handlePowerConfirmation(msg, text, senderLID, userName, isOwner, pending, startTime) {
    logger.info(
      { sender: senderLID, pushName: userName, pendingAction: pending.action },
      'Processing power confirmation response'
    );

    let response;

    if (erinaAI.isAvailable()) {
      // Let Erina parse the confirmation
      const erinaResponse = await erinaAI.chat(text, {
        userName,
        isOwner,
        confirmAction: pending.action,
      });

      const decision = erinaAI.parseConfirmation(erinaResponse);
      logger.info(
        { sender: senderLID, decision, hasResponse: !!erinaResponse },
        'Power confirmation decision'
      );

      if (decision === 'confirmed') {
        // Execute the power action
        try {
          const result = await executeCommand(pending.command, pending.args);
          logger.info(
            { sender: senderLID, command: pending.command },
            'Power action EXECUTED'
          );
          const cleanResponse = erinaAI.stripMarkers(erinaResponse);
          response = `${cleanResponse}\n\n${result.fallbackText}`;
        } catch (err) {
          logger.error(
            { sender: senderLID, command: pending.command, err: err.message },
            'Power action execution FAILED'
          );
          response = `${erinaAI.stripMarkers(erinaResponse)}\n\n❌ Tapi maaf, Erina gagal mengeksekusi perintahnya: ${err.message}`;
        }
        erinaAI.clearPendingAction(senderLID);
      } else if (decision === 'cancelled') {
        erinaAI.clearPendingAction(senderLID);
        response = erinaAI.stripMarkers(erinaResponse);
      } else {
        // Erina couldn't determine — ask again
        logger.warn(
          { sender: senderLID, rawResponse: erinaResponse?.substring(0, 200) },
          'Erina could not parse confirmation — asking again'
        );
        response = erinaAI.stripMarkers(erinaResponse) ||
          'Hmm, Erina belum paham jawabanmu, Master... Coba bilang "ya" atau "tidak" ya~';
      }
    } else {
      // Fallback: simple yes/no check
      const lowerText = text.toLowerCase().trim();
      const yesPatterns = ['ya', 'yes', 'iya', 'ok', 'oke', 'gas', 'lakukan', 'sip', 'y'];
      const isConfirmed = yesPatterns.some((p) => lowerText.startsWith(p));

      if (isConfirmed) {
        const result = await executeCommand(pending.command, pending.args);
        response = result.fallbackText;
      } else {
        response = '❌ Perintah dibatalkan.';
      }
      erinaAI.clearPendingAction(senderLID);
    }

    await this.sendPresence(msg.key.remoteJid, 'paused');
    await this.sendMessage(msg.key.remoteJid, response);

    const elapsed = Date.now() - startTime;
    this.addToHistory(senderLID, text, response);
    this.logCommand(senderLID, `confirm:${pending.action}`, response, 'success', elapsed);

    logger.info(
      { sender: senderLID, pushName: userName, action: `confirm:${pending.action}`, elapsed },
      'Power confirmation processed'
    );
  }

  // ── Handler: Casual Chat ───────────────────────────

  /**
   * Handle casual conversation — pure Erina chat.
   */
  async handleCasualChat(text, userName, isOwner) {
    if (erinaAI.isAvailable()) {
      const erinaResponse = await erinaAI.chat(text, { userName, isOwner });
      if (erinaResponse) return erinaAI.stripMarkers(erinaResponse);
    }

    // Fallback when Erina is offline
    return `💜 Erina sedang tidak tersedia saat ini.\n\nKetik *help* untuk melihat daftar perintah server yang tersedia.`;
  }

  // ══════════════════════════════════════════════════
  // MESSAGING & CONNECTION (unchanged from original)
  // ══════════════════════════════════════════════════

  /**
   * Send composing/paused presence to indicate typing.
   */
  async sendPresence(jid, type = 'composing') {
    if (!this.sock || this.status !== 'connected') return;

    try {
      await this.sock.sendPresenceUpdate(type, jid);
    } catch (err) {
      // Non-critical, ignore
      logger.debug({ err: err.message }, 'Failed to send presence update');
    }
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
   * Deduplicates recipients to prevent double-sends when the same person
   * is listed as both phone number and LID format.
   */
  async sendAlert(text) {
    const numbers = config.whatsapp.allowedNumbers;
    if (numbers.length === 0) {
      logger.warn('No whitelisted numbers for alert');
      return;
    }

    // Deduplicate: only send once per unique JID
    const sentJids = new Set();
    for (const number of numbers) {
      const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
      if (sentJids.has(jid)) continue;
      sentJids.add(jid);
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
   */
  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
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
   */
  async logout() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout();
      } catch {
        // Ignore errors during logout
      }
      this.sock = null;
    }

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
   */
  async resetSession() {
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

    await this.clearSessionFiles();

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
   * Helper to delete all files in session directory.
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
      erinaAvailable: erinaAI.isAvailable(),
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
      { type: 'out', sender: 'ERINA', text: response, timestamp },
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
