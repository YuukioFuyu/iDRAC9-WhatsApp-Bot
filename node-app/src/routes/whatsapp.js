/**
 * WhatsApp routes — QR display, pairing code, status, chat history.
 *
 * SSE FIX: Now listens for 'reconnecting' event from baileys service.
 * The SSE stream stays open during reconnect cycles, so the browser
 * continues to receive new QR codes without deadlocking.
 */

import QRCode from 'qrcode';
import whatsappService from '../services/baileys.js';
import logger from '../services/logger.js';

export default async function whatsappRoutes(fastify) {
  // All WhatsApp API routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /whatsapp/status — connection status ─────
  fastify.get('/whatsapp/status', async () => {
    return {
      success: true,
      data: whatsappService.getStatus(),
    };
  });

  // ── GET /whatsapp/qr — Server-Sent Events for QR ─
  fastify.get('/whatsapp/qr', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering
    });

    // Send current status
    sendSSE(reply.raw, 'status', whatsappService.getStatus());

    // If QR is already available, send it immediately
    if (whatsappService.qrCode) {
      try {
        const qrDataUrl = await QRCode.toDataURL(whatsappService.qrCode, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        sendSSE(reply.raw, 'qr', { qr: qrDataUrl });
      } catch (err) {
        logger.error({ err: err.message }, 'QR initial render error');
      }
    }

    // Listen for new QR codes
    const onQR = async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
        sendSSE(reply.raw, 'qr', { qr: qrDataUrl });
      } catch (err) {
        logger.error({ err: err.message }, 'QR generation error');
      }
    };

    const onConnected = (info) => {
      sendSSE(reply.raw, 'connected', info);
    };

    // KEY FIX: 'reconnecting' keeps the SSE open and tells the client to wait
    const onReconnecting = (info) => {
      sendSSE(reply.raw, 'reconnecting', info);
    };

    // 'disconnected' only fires on explicit logout or max retries
    const onDisconnected = (info) => {
      sendSSE(reply.raw, 'disconnected', info || {});
    };

    whatsappService.on('qr', onQR);
    whatsappService.on('connected', onConnected);
    whatsappService.on('reconnecting', onReconnecting);
    whatsappService.on('disconnected', onDisconnected);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      sendSSE(reply.raw, 'ping', { time: Date.now() });
    }, 15000);

    // Cleanup on client disconnect
    request.raw.on('close', () => {
      whatsappService.off('qr', onQR);
      whatsappService.off('connected', onConnected);
      whatsappService.off('reconnecting', onReconnecting);
      whatsappService.off('disconnected', onDisconnected);
      clearInterval(heartbeat);
    });

    // Don't close the response — SSE stays open
    return reply;
  });

  // ── POST /whatsapp/connect — initiate connection ─
  fastify.post('/whatsapp/connect', async (request, reply) => {
    if (whatsappService.status === 'connected') {
      return { success: true, message: 'Already connected' };
    }

    try {
      await whatsappService.connect();
      return { success: true, message: 'Connection initiated — scan QR code' };
    } catch (err) {
      logger.error({ err: err.message }, 'WhatsApp connect failed');
      return reply.status(500).send({
        success: false,
        message: `Connection failed: ${err.message}`,
      });
    }
  });

  // ── POST /whatsapp/pairing-code — request pairing code ─
  fastify.post('/whatsapp/pairing-code', async (request, reply) => {
    const { phoneNumber } = request.body || {};

    if (!phoneNumber) {
      return reply.status(400).send({
        success: false,
        message: 'Phone number is required (e.g., 628xxxxxxxxxx)',
      });
    }

    // Clean phone number: remove +, spaces, dashes
    const cleanNumber = phoneNumber.replace(/[\s+\-()]/g, '');

    try {
      // Ensure socket is initialized
      if (!whatsappService.sock) {
        await whatsappService.connect();
        // Wait for socket to stabilize
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      const code = await whatsappService.requestPairingCode(cleanNumber);
      return {
        success: true,
        data: { code, phoneNumber: cleanNumber },
        message: 'Pairing code generated — enter it in WhatsApp',
      };
    } catch (err) {
      logger.error({ err: err.message }, 'Pairing code request failed');
      return reply.status(500).send({
        success: false,
        message: `Pairing code failed: ${err.message}`,
      });
    }
  });

  // ── POST /whatsapp/disconnect — full logout + wipe session ───
  fastify.post('/whatsapp/disconnect', async () => {
    await whatsappService.logout();
    return { success: true, message: 'WhatsApp logged out and session wiped' };
  });

  // ── POST /whatsapp/reset — wipe session & start fresh ──
  fastify.post('/whatsapp/reset', async () => {
    await whatsappService.resetSession();
    return {
      success: true,
      message: 'Session data cleared — ready for fresh pairing',
    };
  });

  // ── GET /whatsapp/chat-logs — recent chat history ─
  fastify.get('/whatsapp/chat-logs', async (request) => {
    const limit = parseInt(request.query.limit) || 50;
    return {
      success: true,
      data: whatsappService.getChatHistory(limit),
    };
  });

  // ── POST /whatsapp/send — send message manually ──
  fastify.post('/whatsapp/send', async (request, reply) => {
    const { number, message } = request.body || {};

    if (!number || !message) {
      return reply.status(400).send({
        success: false,
        message: 'Both number and message are required',
      });
    }

    const jid = `${number.replace(/[\s+\-()]/g, '')}@s.whatsapp.net`;
    const sent = await whatsappService.sendMessage(jid, message);

    return {
      success: sent,
      message: sent ? 'Message sent' : 'Failed to send message',
    };
  });
}

// ── SSE Helper ─────────────────────────────────────
function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection may be closed
  }
}
