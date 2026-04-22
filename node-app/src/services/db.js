/**
 * Database Service — Dual PostgreSQL support (External + Internal fallback).
 *
 * Strategy:
 * 1. If External PostgreSQL is configured (PG_HOST + PG_USERNAME), connect to it
 * 2. If External fails or not configured, fallback to Internal PostgreSQL (memories-db container)
 * 3. Internal PostgreSQL uses pgvector/pgvector:pg16 — replaces legacy SQLite fallback
 *
 * Both databases use the same schema and fully support pgvector for Erina RAG memory.
 */

import pg from 'pg';
import config from '../config.js';
import logger from './logger.js';

const { Pool } = pg;

// ── Database state ─────────────────────────────────
let pgPool = null;
let dbLabel = null; // 'External' | 'Internal (memories-db)'

// ── Schema Definition (PostgreSQL) ─────────────────
const SCHEMA_POSTGRES = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS idrac_servers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    host VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    verify_ssl BOOLEAN DEFAULT FALSE,
    firmware_version VARCHAR(50) DEFAULT '',
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS command_logs (
    id SERIAL PRIMARY KEY,
    sender_number VARCHAR(50) NOT NULL,
    command TEXT NOT NULL,
    response TEXT,
    server_id INTEGER REFERENCES idrac_servers(id),
    status VARCHAR(20) DEFAULT 'success',
    response_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alert_logs (
    id SERIAL PRIMARY KEY,
    alert_type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    server_id INTEGER REFERENCES idrac_servers(id),
    sent_to TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK(type IN ('power', 'redfish')),
    action TEXT NOT NULL,
    schedule_time VARCHAR(5) NOT NULL,
    schedule_mode VARCHAR(20) NOT NULL DEFAULT 'once' CHECK(schedule_mode IN ('once', 'weekly', 'specific')),
    schedule_date VARCHAR(10) DEFAULT NULL,
    specific_repeat BOOLEAN DEFAULT FALSE,
    description TEXT DEFAULT '',
    is_enabled BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMP,
    last_result TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedule_days (
    id SERIAL PRIMARY KEY,
    schedule_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    UNIQUE(schedule_id, day_of_week)
  );

  CREATE TABLE IF NOT EXISTS schedule_dates (
    id SERIAL PRIMARY KEY,
    schedule_id INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
    day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    UNIQUE(schedule_id, month, day)
  );

  CREATE INDEX IF NOT EXISTS idx_cmd_logs_created ON command_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cmd_logs_sender ON command_logs(sender_number);
  CREATE INDEX IF NOT EXISTS idx_alert_logs_created ON alert_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_servers_active ON idrac_servers(is_active);
  CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(is_enabled);
  CREATE INDEX IF NOT EXISTS idx_schedule_days_sid ON schedule_days(schedule_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_dates_sid ON schedule_dates(schedule_id);
`;

// ── Initialize Database ────────────────────────────

/**
 * Wait helper — resolves after ms milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect to PostgreSQL with retry logic.
 * Retries up to maxRetries times with retryDelay between attempts.
 * Essential for single-container deployment where PostgreSQL may
 * need time to initialize (especially first run with initdb).
 */
async function initDatabase() {
  const maxRetries = 15;
  const retryDelay = 3000; // 3 seconds between retries

  // 1. Try External PostgreSQL first (no retry — if configured but fails, fallback)
  if (config.db.postgres.isConfigured) {
    try {
      await initPool(config.db.postgres, 'External');
      return;
    } catch (err) {
      logger.warn(
        { err: err.message },
        '⚠️  External PostgreSQL failed, trying Internal (memories-db)...'
      );
    }
  }

  // 2. Fallback to Internal PostgreSQL with retry
  if (config.db.fallback.isConfigured) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await initPool(config.db.fallback, 'Internal (memories-db)');
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          logger.warn(
            `⏳ PostgreSQL not ready (attempt ${attempt}/${maxRetries}): ${err.message} — retrying in ${retryDelay / 1000}s...`
          );
          await sleep(retryDelay);
        } else {
          logger.error(`❌ PostgreSQL failed after ${maxRetries} attempts`);
          throw err;
        }
      }
    }
  }

  throw new Error('No database configured — set PG_HOST or MEM_PG_HOST in .env');
}

/**
 * Create a connection pool and initialize schema.
 */
async function initPool(pgConfig, label) {
  pgPool = new Pool({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.username,
    password: pgConfig.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection + run schema
  const client = await pgPool.connect();
  try {
    await client.query('SELECT 1');
    await client.query(SCHEMA_POSTGRES);
    dbLabel = label;
    logger.info(
      `✅ Database: PostgreSQL ${label} → ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`
    );
  } finally {
    client.release();
  }
}

// ── Query Interface ────────────────────────────────

/**
 * Execute a query and return all rows.
 * @param {string} sql - SQL query (use $1, $2 for parameters)
 * @param {Array} params - Query parameters
 * @returns {Array} rows
 */
async function query(sql, params = []) {
  const result = await pgPool.query(sql, params);
  return result.rows;
}

/**
 * Execute a query and return the first row.
 */
async function queryOne(sql, params = []) {
  const result = await pgPool.query(sql, params);
  return result.rows[0] || null;
}

/**
 * Execute an INSERT/UPDATE/DELETE and return result info.
 */
async function execute(sql, params = []) {
  let pgSql = sql;
  if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
    pgSql += ' RETURNING id';
  }
  const result = await pgPool.query(pgSql, params);
  return {
    changes: result.rowCount,
    lastInsertRowid: result.rows?.[0]?.id,
  };
}

/**
 * Close database connections.
 */
async function closeDatabase() {
  if (pgPool) {
    await pgPool.end();
    logger.info('PostgreSQL pool closed');
  }
}

/**
 * Get the PostgreSQL pool instance (for direct queries, e.g., pgvector).
 */
function getPgPool() {
  return pgPool;
}

/**
 * Get the current database label.
 */
function getDbLabel() {
  return dbLabel;
}

// ── Seed default admin user ────────────────────────

async function seedAdminUser() {
  const existing = await queryOne(
    'SELECT id FROM users WHERE username = $1',
    [config.admin.username]
  );

  if (!existing) {
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.hash(config.admin.password, 10);
    await execute(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [config.admin.username, hash]
    );
    logger.info(`👤 Admin user created: ${config.admin.username}`);
  }
}

// ── Seed bootstrap iDRAC server from .env ──────────

async function seedBootstrapServer() {
  if (!config.idrac.host) return;

  const existing = await queryOne(
    'SELECT id FROM idrac_servers WHERE host = $1',
    [config.idrac.host]
  );

  if (!existing) {
    await execute(
      `INSERT INTO idrac_servers (name, host, username, password, is_default)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'Bootstrap Server',
        config.idrac.host,
        process.env.IDRAC_USERNAME || 'root',
        process.env.IDRAC_PASSWORD || 'calvin',
        1, // is_default = true
      ]
    );
    logger.info(`🖥️  Bootstrap iDRAC server added: ${config.idrac.host}`);
  }
}

export {
  initDatabase,
  closeDatabase,
  query,
  queryOne,
  execute,
  getPgPool,
  getDbLabel,
  seedAdminUser,
  seedBootstrapServer,
};
