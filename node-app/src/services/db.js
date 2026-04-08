/**
 * Database Service — Dual database support (PostgreSQL + SQLite fallback).
 *
 * Strategy:
 * 1. If PostgreSQL is configured (PG_HOST + PG_USERNAME), try to connect
 * 2. If PostgreSQL fails (down/auth error/etc.), auto-fallback to SQLite
 * 3. If PostgreSQL is not configured, use SQLite directly
 * 4. SQLite is ALWAYS available as the fallback
 *
 * Both databases use the same schema and query interface.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import config from '../config.js';
import logger from './logger.js';

const { Pool } = pg;

// ── Database state ─────────────────────────────────
let activeDriver = null;  // 'postgres' | 'sqlite'
let sqliteDb = null;
let pgPool = null;

// ── Schema Definition ──────────────────────────────
const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS idrac_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    verify_ssl INTEGER DEFAULT 0,
    firmware_version TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS command_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_number TEXT NOT NULL,
    command TEXT NOT NULL,
    response TEXT,
    server_id INTEGER,
    status TEXT DEFAULT 'success',
    response_time_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES idrac_servers(id)
  );

  CREATE TABLE IF NOT EXISTS alert_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type TEXT NOT NULL,
    message TEXT NOT NULL,
    server_id INTEGER,
    sent_to TEXT,
    acknowledged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES idrac_servers(id)
  );

  CREATE INDEX IF NOT EXISTS idx_cmd_logs_created ON command_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cmd_logs_sender ON command_logs(sender_number);
  CREATE INDEX IF NOT EXISTS idx_alert_logs_created ON alert_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_servers_active ON idrac_servers(is_active);
`;

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

  CREATE INDEX IF NOT EXISTS idx_cmd_logs_created ON command_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cmd_logs_sender ON command_logs(sender_number);
  CREATE INDEX IF NOT EXISTS idx_alert_logs_created ON alert_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_servers_active ON idrac_servers(is_active);
`;

// ── Initialize Database ────────────────────────────

async function initDatabase() {
  // Try PostgreSQL first if configured
  if (config.db.postgres.isConfigured) {
    try {
      await initPostgres();
      return;
    } catch (err) {
      logger.warn(
        { err: err.message },
        '⚠️  PostgreSQL connection failed, falling back to SQLite'
      );
    }
  }

  // Fallback to SQLite (always works)
  initSQLite();
}

function initSQLite() {
  const dbPath = config.db.sqlitePath;
  const dbDir = dirname(dbPath);

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Run schema
  sqliteDb.exec(SCHEMA_SQLITE);

  activeDriver = 'sqlite';
  logger.info(`✅ Database: SQLite → ${dbPath}`);
}

async function initPostgres() {
  pgPool = new Pool({
    host: config.db.postgres.host,
    port: config.db.postgres.port,
    database: config.db.postgres.database,
    user: config.db.postgres.username,
    password: config.db.postgres.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Test connection
  const client = await pgPool.connect();
  try {
    await client.query('SELECT 1');
    // Run schema
    await client.query(SCHEMA_POSTGRES);
    activeDriver = 'postgres';
    logger.info(
      `✅ Database: PostgreSQL → ${config.db.postgres.host}:${config.db.postgres.port}/${config.db.postgres.database}`
    );
  } finally {
    client.release();
  }
}

// ── Query Interface (unified for both drivers) ─────

/**
 * Execute a query and return all rows.
 * @param {string} sql - SQL query (use $1, $2 for PG; ? for SQLite)
 * @param {Array} params - Query parameters
 * @returns {Array} rows
 */
async function query(sql, params = []) {
  if (activeDriver === 'postgres') {
    const result = await pgPool.query(sql, params);
    return result.rows;
  }

  // Convert PG-style $1, $2 to SQLite ? placeholders
  const sqliteSql = sql.replace(/\$(\d+)/g, '?');
  const stmt = sqliteDb.prepare(sqliteSql);
  return stmt.all(...params);
}

/**
 * Execute a query and return the first row.
 */
async function queryOne(sql, params = []) {
  if (activeDriver === 'postgres') {
    const result = await pgPool.query(sql, params);
    return result.rows[0] || null;
  }

  const sqliteSql = sql.replace(/\$(\d+)/g, '?');
  const stmt = sqliteDb.prepare(sqliteSql);
  return stmt.get(...params) || null;
}

/**
 * Execute an INSERT/UPDATE/DELETE and return result info.
 */
async function execute(sql, params = []) {
  if (activeDriver === 'postgres') {
    const result = await pgPool.query(sql, params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id,
    };
  }

  const sqliteSql = sql.replace(/\$(\d+)/g, '?');
  const stmt = sqliteDb.prepare(sqliteSql);
  const result = stmt.run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
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
  if (sqliteDb) {
    sqliteDb.close();
    logger.info('SQLite database closed');
  }
}

/**
 * Get the active database driver name.
 */
function getActiveDriver() {
  return activeDriver;
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
  getActiveDriver,
  seedAdminUser,
  seedBootstrapServer,
};
