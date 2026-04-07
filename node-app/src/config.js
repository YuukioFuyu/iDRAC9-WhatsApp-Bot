/**
 * Configuration module — loads and validates environment variables.
 * Uses dotenv for loading and Joi for schema validation.
 */

import dotenv from 'dotenv';
import Joi from 'joi';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (one level up from src/)
dotenv.config({ path: join(__dirname, '..', '..', '.env') });
// Also try local .env
dotenv.config({ path: join(__dirname, '..', '.env') });

// ── Validation Schema ──────────────────────────────

const schema = Joi.object({
  // App
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('production'),
  APP_PORT: Joi.number().integer().min(1).max(65535).default(3000),
  APP_HOST: Joi.string().default('0.0.0.0'),
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('24h'),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),

  // Admin
  ADMIN_USERNAME: Joi.string().min(3).required(),
  ADMIN_PASSWORD: Joi.string().min(4).required(),

  // Python API
  PY_API_URL: Joi.string().uri().default('http://python-api:8000'),

  // iDRAC (bootstrap — also passed to Python, but Node reads for display)
  IDRAC_HOST: Joi.string().default('https://192.168.1.100'),

  // Redis
  REDIS_ENABLED: Joi.boolean().default(false),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().integer().default(6379),
  REDIS_USERNAME: Joi.string().allow('', null).default(''),
  REDIS_PASSWORD: Joi.string().allow('', null).default(''),
  REDIS_DB: Joi.number().integer().default(0),
  REDIS_PREFIX: Joi.string().allow('', null).default('idrac:'),

  // WhatsApp
  WA_SESSION_PATH: Joi.string().default('./sessions'),
  WA_ALLOWED_NUMBERS: Joi.string().allow('', null).default(''),
  WA_COMMAND_PREFIX: Joi.string().allow('', null).default(''),
  WA_RATE_LIMIT: Joi.number().integer().min(1).default(10),

  // Database — SQLite (always available)
  DB_PATH: Joi.string().default('./data/idrac-bot.db'),

  // Database — PostgreSQL (optional, primary when configured)
  PG_HOST: Joi.string().allow('', null).default(''),
  PG_PORT: Joi.number().integer().default(5432),
  PG_DATABASE: Joi.string().default('idrac_bot'),
  PG_USERNAME: Joi.string().allow('', null).default(''),
  PG_PASSWORD: Joi.string().allow('', null).default(''),

  // Alert System
  ALERT_POLL_INTERVAL: Joi.number().integer().min(10).default(60),
  ALERT_TEMP_THRESHOLD: Joi.number().integer().default(75),
  ALERT_ENABLED: Joi.boolean().default(true),

}).unknown(true); // Allow unknown env vars

// ── Validate & Export ──────────────────────────────

const { error, value: envVars } = schema.validate(process.env, {
  abortEarly: false,
  stripUnknown: false,
});

if (error) {
  console.error('❌ Environment validation error:');
  error.details.forEach((detail) => {
    console.error(`   → ${detail.message}`);
  });
  process.exit(1);
}

const config = {
  env: envVars.NODE_ENV,
  isDev: envVars.NODE_ENV === 'development',

  app: {
    port: envVars.APP_PORT,
    host: envVars.APP_HOST,
  },

  jwt: {
    secret: envVars.JWT_SECRET,
    expiresIn: envVars.JWT_EXPIRES_IN,
  },

  admin: {
    username: envVars.ADMIN_USERNAME,
    password: envVars.ADMIN_PASSWORD,
  },

  pythonApi: {
    url: envVars.PY_API_URL,
  },

  idrac: {
    host: envVars.IDRAC_HOST,
  },

  redis: {
    enabled: envVars.REDIS_ENABLED,
    host: envVars.REDIS_HOST,
    port: envVars.REDIS_PORT,
    username: envVars.REDIS_USERNAME || undefined,
    password: envVars.REDIS_PASSWORD || undefined,
    db: envVars.REDIS_DB,
    prefix: envVars.REDIS_PREFIX || 'idrac:',
  },

  whatsapp: {
    sessionPath: envVars.WA_SESSION_PATH,
    allowedNumbers: envVars.WA_ALLOWED_NUMBERS
      ? envVars.WA_ALLOWED_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean)
      : [],
    commandPrefix: envVars.WA_COMMAND_PREFIX || '', // Empty = no prefix required
    rateLimit: envVars.WA_RATE_LIMIT,
  },

  db: {
    sqlitePath: envVars.DB_PATH,
    postgres: {
      host: envVars.PG_HOST,
      port: envVars.PG_PORT,
      database: envVars.PG_DATABASE,
      username: envVars.PG_USERNAME,
      password: envVars.PG_PASSWORD,
      get isConfigured() {
        return !!(envVars.PG_HOST && envVars.PG_USERNAME);
      },
    },
  },



  alert: {
    pollInterval: envVars.ALERT_POLL_INTERVAL,
    tempThreshold: envVars.ALERT_TEMP_THRESHOLD,
    enabled: envVars.ALERT_ENABLED,
  },

  log: {
    level: envVars.LOG_LEVEL,
  },
};

export default config;
