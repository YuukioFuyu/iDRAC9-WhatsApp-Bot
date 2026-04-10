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

  // ═══════════════════════════════════════════════════
  // SCHEDULE CRUD API
  // ═══════════════════════════════════════════════════

  // ── GET /api/schedules — list all schedules ──────
  fastify.get('/api/schedules', async (request) => {
    const { query: dbQuery } = await import('../services/db.js');
    const { search, sort, order } = request.query;

    let sql = 'SELECT * FROM schedules';
    const params = [];
    let paramIdx = 1;

    // Search filter
    if (search) {
      sql += ` WHERE (name LIKE $${paramIdx} OR description LIKE $${paramIdx + 1})`;
      params.push(`%${search}%`, `%${search}%`);
      paramIdx += 2;
    }

    // Sort
    const allowedSorts = ['name', 'type', 'created_at', 'schedule_time', 'is_enabled'];
    const sortField = allowedSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortField} ${sortOrder}`;

    const rows = await dbQuery(sql, params);

    return { success: true, data: rows };
  });

  // ── GET /api/schedules/upcoming — dashboard widget ──
  fastify.get('/api/schedules/upcoming', async () => {
    const { query: dbQuery } = await import('../services/db.js');
    const rows = await dbQuery(
      'SELECT * FROM schedules WHERE is_enabled = $1 ORDER BY schedule_time ASC LIMIT 5',
      [true]
    );
    return { success: true, data: rows };
  });

  // ── GET /api/schedules/:id — get schedule with child data ──
  fastify.get('/api/schedules/:id', async (request, reply) => {
    const { queryOne, query: dbQuery } = await import('../services/db.js');
    const row = await queryOne('SELECT * FROM schedules WHERE id = $1', [request.params.id]);

    if (!row) {
      return reply.status(404).send({ success: false, message: 'Schedule not found' });
    }

    // Load child data
    if (row.schedule_mode === 'weekly') {
      const days = await dbQuery('SELECT day_of_week FROM schedule_days WHERE schedule_id = $1 ORDER BY day_of_week', [row.id]);
      row.days = days.map(d => d.day_of_week);
    } else if (row.schedule_mode === 'specific') {
      const dates = await dbQuery('SELECT month, day FROM schedule_dates WHERE schedule_id = $1 ORDER BY month, day', [row.id]);
      row.dates = dates.map(d => ({ month: d.month, day: d.day }));
    }

    return { success: true, data: row };
  });

  // ── POST /api/schedules — create new schedule ────
  fastify.post('/api/schedules', async (request, reply) => {
    const { execute: dbExecute, queryOne } = await import('../services/db.js');
    const taskScheduler = (await import('../services/task-scheduler.js')).default;
    const { name, type, action, schedule_time, schedule_mode, schedule_date, schedule_days, schedule_dates, specific_repeat, description } = request.body || {};

    // Basic validation
    if (!name || !type || !action || !schedule_time) {
      return reply.status(400).send({ success: false, message: 'Missing required fields: name, type, action, schedule_time' });
    }
    if (!['power', 'redfish'].includes(type)) {
      return reply.status(400).send({ success: false, message: 'Invalid type' });
    }
    if (type === 'power' && !['on', 'off'].includes(action)) {
      return reply.status(400).send({ success: false, message: 'Invalid power action' });
    }
    if (!/^\d{2}:\d{2}$/.test(schedule_time)) {
      return reply.status(400).send({ success: false, message: 'Invalid time format. Must be HH:MM' });
    }
    const mode = schedule_mode || 'once';
    if (!['once', 'weekly', 'specific'].includes(mode)) {
      return reply.status(400).send({ success: false, message: 'Invalid schedule_mode' });
    }

    // Mode-specific validation
    if (mode === 'weekly' && (!schedule_days || !Array.isArray(schedule_days) || schedule_days.length === 0)) {
      return reply.status(400).send({ success: false, message: 'Weekly mode requires at least 1 day selected' });
    }
    if (mode === 'specific' && (!schedule_dates || !Array.isArray(schedule_dates) || schedule_dates.length === 0)) {
      return reply.status(400).send({ success: false, message: 'Specific mode requires at least 1 date selected' });
    }

    // Insert main schedule row
    const result = await dbExecute(
      `INSERT INTO schedules (name, type, action, schedule_time, schedule_mode, schedule_date, specific_repeat, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [name, type, action, schedule_time, mode, schedule_date || null, specific_repeat ? true : false, description || '']
    );

    const scheduleId = result.lastInsertRowid || result.insertId;

    // Insert child rows
    if (mode === 'weekly' && schedule_days) {
      for (const day of schedule_days) {
        await dbExecute('INSERT INTO schedule_days (schedule_id, day_of_week) VALUES ($1, $2)', [scheduleId, day]);
      }
    }
    if (mode === 'specific' && schedule_dates) {
      for (const d of schedule_dates) {
        await dbExecute('INSERT INTO schedule_dates (schedule_id, month, day) VALUES ($1, $2, $3)', [scheduleId, d.month, d.day]);
      }
    }

    await taskScheduler.reload();

    logger.info({ name, type, action, mode }, 'Schedule created');
    return { success: true, message: 'Schedule created', data: { id: scheduleId } };
  });

  // ── PUT /api/schedules/:id — update schedule ─────
  fastify.put('/api/schedules/:id', async (request, reply) => {
    const { execute: dbExecute, queryOne } = await import('../services/db.js');
    const taskScheduler = (await import('../services/task-scheduler.js')).default;
    const { id } = request.params;
    const { name, type, action, schedule_time, schedule_mode, schedule_date, schedule_days, schedule_dates, specific_repeat, description } = request.body || {};

    const existing = await queryOne('SELECT id FROM schedules WHERE id = $1', [id]);
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Schedule not found' });
    }

    if (!name || !type || !action || !schedule_time) {
      return reply.status(400).send({ success: false, message: 'Missing required fields' });
    }

    const mode = schedule_mode || 'once';

    // Update main row
    await dbExecute(
      `UPDATE schedules SET name = $1, type = $2, action = $3, schedule_time = $4, schedule_mode = $5,
       schedule_date = $6, specific_repeat = $7, description = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9`,
      [name, type, action, schedule_time, mode, schedule_date || null, specific_repeat ? true : false, description || '', id]
    );

    // Replace child rows: delete old, insert new
    await dbExecute('DELETE FROM schedule_days WHERE schedule_id = $1', [id]);
    await dbExecute('DELETE FROM schedule_dates WHERE schedule_id = $1', [id]);

    if (mode === 'weekly' && schedule_days) {
      for (const day of schedule_days) {
        await dbExecute('INSERT INTO schedule_days (schedule_id, day_of_week) VALUES ($1, $2)', [id, day]);
      }
    }
    if (mode === 'specific' && schedule_dates) {
      for (const d of schedule_dates) {
        await dbExecute('INSERT INTO schedule_dates (schedule_id, month, day) VALUES ($1, $2, $3)', [id, d.month, d.day]);
      }
    }

    await taskScheduler.reload();

    logger.info({ id, name, mode }, 'Schedule updated');
    return { success: true, message: 'Schedule updated' };
  });

  // ── PATCH /api/schedules/:id/toggle — enable/disable ─
  fastify.patch('/api/schedules/:id/toggle', async (request, reply) => {
    const { execute: dbExecute, queryOne } = await import('../services/db.js');
    const taskScheduler = (await import('../services/task-scheduler.js')).default;
    const { id } = request.params;

    const existing = await queryOne('SELECT id, is_enabled FROM schedules WHERE id = $1', [id]);
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Schedule not found' });
    }

    const newState = existing.is_enabled ? false : true;
    await dbExecute(
      'UPDATE schedules SET is_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newState, id]
    );

    await taskScheduler.reload();

    logger.info({ id, enabled: newState }, 'Schedule toggled');
    return { success: true, message: `Schedule ${newState ? 'enabled' : 'disabled'}`, data: { is_enabled: newState } };
  });

  // ── DELETE /api/schedules/:id — delete schedule (CASCADE cleans child rows) ──
  fastify.delete('/api/schedules/:id', async (request, reply) => {
    const { execute: dbExecute, queryOne } = await import('../services/db.js');
    const taskScheduler = (await import('../services/task-scheduler.js')).default;
    const { id } = request.params;

    const existing = await queryOne('SELECT id FROM schedules WHERE id = $1', [id]);
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Schedule not found' });
    }

    await dbExecute('DELETE FROM schedules WHERE id = $1', [id]);

    await taskScheduler.reload();

    logger.info({ id }, 'Schedule deleted');
    return { success: true, message: 'Schedule deleted' };
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
