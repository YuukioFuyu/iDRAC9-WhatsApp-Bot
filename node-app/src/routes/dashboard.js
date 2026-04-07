/**
 * Dashboard routes — SSR pages with Nunjucks templates.
 */

import { getActiveDriver } from '../services/db.js';
import config from '../config.js';

export default async function dashboardRoutes(fastify) {
  // All dashboard routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET / — redirect to dashboard ────────────────
  fastify.get('/', async (request, reply) => {
    return reply.redirect('/dashboard');
  });

  // ── GET /dashboard — main dashboard page ─────────
  fastify.get('/dashboard', async (request, reply) => {
    return reply.view('dashboard.html', {
      user: request.user,
      idracHost: config.idrac.host,
      dbDriver: getActiveDriver(),
      config: {
        alertEnabled: config.alert.enabled,
        pollInterval: config.alert.pollInterval,
        tempThreshold: config.alert.tempThreshold,
      },
    });
  });

  // ── GET /whatsapp — WhatsApp management page ─────
  fastify.get('/whatsapp', async (request, reply) => {
    return reply.view('whatsapp.html', {
      user: request.user,
      allowedNumbers: config.whatsapp.allowedNumbers,
      commandPrefix: config.whatsapp.commandPrefix,
    });
  });
}
