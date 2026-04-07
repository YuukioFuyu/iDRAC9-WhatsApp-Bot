/**
 * Fastify App — main entry point.
 *
 * Registers all plugins, routes, and starts the server.
 */

import Fastify from 'fastify';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import nunjucks from 'nunjucks';

import config from './config.js';
import logger from './services/logger.js';
import { registerAuth } from './middleware/auth.js';
import { initDatabase, closeDatabase, seedAdminUser, seedBootstrapServer } from './services/db.js';
import whatsappService from './services/baileys.js';
import alertScheduler from './services/scheduler.js';

// ── Path resolution ────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Create Fastify instance ────────────────────────
const fastify = Fastify({
  logger: false, // We use pino directly via our logger
  trustProxy: true,
});

// ── Register Plugins ───────────────────────────────

// Cookie support (required for JWT cookie auth)
await fastify.register(import('@fastify/cookie'));

// Form body parser
await fastify.register(import('@fastify/formbody'));

// JWT Auth
registerAuth(fastify);

// Static files (CSS, JS, images)
await fastify.register(import('@fastify/static'), {
  root: join(__dirname, 'public'),
  prefix: '/public/',
});

// Template engine (Nunjucks)
const nunjucksEnv = nunjucks.configure(join(__dirname, 'views'), {
  autoescape: true,
  noCache: config.isDev,
  watch: config.isDev,
});

await fastify.register(import('@fastify/view'), {
  engine: { nunjucks },
  root: join(__dirname, 'views'),
  viewExt: 'html',
  options: {
    onConfigure: (env) => {
      // Custom Nunjucks filters
      env.addFilter('formatDate', (str) => {
        return new Date(str).toLocaleString('id-ID');
      });
      env.addFilter('truncate', (str, len) => {
        if (!str) return '';
        return str.length > len ? str.substring(0, len) + '...' : str;
      });
    },
  },
});

// ── Register Routes ────────────────────────────────
await fastify.register(import('./routes/auth.js'));
await fastify.register(import('./routes/dashboard.js'));
await fastify.register(import('./routes/api.js'));
await fastify.register(import('./routes/whatsapp.js'));

// ── Startup Sequence ───────────────────────────────
async function start() {
  try {
    logger.info('═'.repeat(60));
    logger.info('🚀 iDRAC9 WhatsApp Bot starting...');
    logger.info('═'.repeat(60));

    // 1. Initialize Database (PG or SQLite)
    await initDatabase();

    // 2. Seed admin user
    await seedAdminUser();

    // 3. Seed bootstrap iDRAC server from .env
    await seedBootstrapServer();

    // 4. Start Fastify server
    await fastify.listen({
      port: config.app.port,
      host: config.app.host,
    });

    logger.info(`✅ Web server: http://${config.app.host}:${config.app.port}`);
    logger.info(`   Dashboard:  http://localhost:${config.app.port}/dashboard`);
    logger.info(`   Python API: ${config.pythonApi.url}`);

    // 5. WhatsApp — auto-reconnect if existing session found
    const { existsSync, readdirSync } = await import('fs');
    const sessionDir = config.whatsapp.sessionPath;
    const hasSession = existsSync(sessionDir) &&
      readdirSync(sessionDir).some(f => f.endsWith('.json'));

    if (hasSession) {
      logger.info('📱 Existing WhatsApp session found — auto-reconnecting...');
      whatsappService.connect().catch(err => {
        logger.warn({ err: err.message }, '⚠️ WhatsApp auto-reconnect failed — connect manually via Dashboard');
      });
    } else {
      logger.info('📱 No WhatsApp session — connect via Dashboard → WhatsApp');
    }

    // 6. Start Alert Scheduler
    alertScheduler.start();

    logger.info('═'.repeat(60));
    logger.info('🎉 All systems operational!');
    logger.info('═'.repeat(60));
  } catch (err) {
    logger.fatal({ err: err.message }, '💀 Fatal startup error');
    process.exit(1);
  }
}

// ── Graceful Shutdown ──────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);

  alertScheduler.stop();

  try {
    await whatsappService.disconnect();
  } catch {
    // Ignore
  }

  await closeDatabase();
  await fastify.close();

  logger.info('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ──────────────────────────────────────────
start();
