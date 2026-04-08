/**
 * API routes — proxy to Python Redfish API + merged status.
 * All routes require JWT authentication.
 */

import { redfishClient, RedfishBridgeError } from '../services/redfish-client.js';
import logger from '../services/logger.js';

export default async function apiRoutes(fastify) {
  // All API routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/status — combined dashboard status ──
  fastify.get('/api/status', async (request, reply) => {
    try {
      const data = await redfishClient.getFullStatus();
      return { success: true, data };
    } catch (err) {
      return handleError(reply, err, 'Failed to get status');
    }
  });

  // ── GET /api/system ──────────────────────────────
  fastify.get('/api/system', async (request, reply) => {
    try {
      return await redfishClient.getSystem();
    } catch (err) {
      return handleError(reply, err, 'Failed to get system info');
    }
  });

  // ── GET /api/power ───────────────────────────────
  fastify.get('/api/power', async (request, reply) => {
    try {
      return await redfishClient.getPowerState();
    } catch (err) {
      return handleError(reply, err, 'Failed to get power state');
    }
  });

  // ── GET /api/power/details ───────────────────────
  fastify.get('/api/power/details', async (request, reply) => {
    try {
      return await redfishClient.getPowerDetails();
    } catch (err) {
      return handleError(reply, err, 'Failed to get power details');
    }
  });

  // ── POST /api/power/:action ──────────────────────
  fastify.post('/api/power/:action', async (request, reply) => {
    const { action } = request.params;
    const { force } = request.body || {};

    try {
      let result;
      switch (action) {
        case 'on':
          result = await redfishClient.powerOn();
          break;
        case 'off':
          result = await redfishClient.powerOff(force);
          break;
        case 'reset':
          result = await redfishClient.powerReset(force);
          break;
        default:
          return reply.status(400).send({
            success: false,
            message: `Invalid power action: ${action}. Valid: on, off, reset`,
          });
      }

      logger.warn(
        { action, force, user: request.user.username },
        'Power action executed'
      );
      return result;
    } catch (err) {
      return handleError(reply, err, `Power ${action} failed`);
    }
  });

  // ── GET /api/thermal ─────────────────────────────
  fastify.get('/api/thermal', async (request, reply) => {
    try {
      return await redfishClient.getThermal();
    } catch (err) {
      return handleError(reply, err, 'Failed to get thermal data');
    }
  });

  // ── GET /api/storage ─────────────────────────────
  fastify.get('/api/storage', async (request, reply) => {
    try {
      return await redfishClient.getStorage();
    } catch (err) {
      return handleError(reply, err, 'Failed to get storage data');
    }
  });

  // ── GET /api/logs ────────────────────────────────
  fastify.get('/api/logs', async (request, reply) => {
    const limit = parseInt(request.query.limit) || 50;
    try {
      return await redfishClient.getLogs(limit);
    } catch (err) {
      return handleError(reply, err, 'Failed to get logs');
    }
  });

  // ── GET /api/network ─────────────────────────────
  fastify.get('/api/network', async (request, reply) => {
    try {
      return await redfishClient.getNetwork();
    } catch (err) {
      return handleError(reply, err, 'Failed to get network data');
    }
  });

  // ── GET /api/memory ──────────────────────────────
  fastify.get('/api/memory', async (request, reply) => {
    try {
      return await redfishClient.getMemory();
    } catch (err) {
      return handleError(reply, err, 'Failed to get memory data');
    }
  });

  // ── GET /api/processors ──────────────────────────
  fastify.get('/api/processors', async (request, reply) => {
    try {
      return await redfishClient.getProcessors();
    } catch (err) {
      return handleError(reply, err, 'Failed to get processor data');
    }
  });

  // ── POST /api/actions/idrac-reset ────────────────
  fastify.post('/api/actions/idrac-reset', async (request, reply) => {
    try {
      const result = await redfishClient.resetIdrac();
      logger.warn({ user: request.user.username }, 'iDRAC reset executed via Web UI');
      return result;
    } catch (err) {
      return handleError(reply, err, 'Failed to reset iDRAC');
    }
  });

  // ── GET /api/db-driver — check active DB ─────────
  fastify.get('/api/db-driver', async () => {
    const { getActiveDriver } = await import('../services/db.js');
    return {
      success: true,
      data: { driver: getActiveDriver() },
    };
  });
}

// ── Error handler ──────────────────────────────────
function handleError(reply, err, fallbackMessage) {
  if (err instanceof RedfishBridgeError) {
    return reply.status(err.statusCode).send({
      success: false,
      message: err.message,
      data: err.data,
    });
  }

  logger.error({ err: err.message }, fallbackMessage);
  return reply.status(500).send({
    success: false,
    message: fallbackMessage,
    detail: err.message,
  });
}
