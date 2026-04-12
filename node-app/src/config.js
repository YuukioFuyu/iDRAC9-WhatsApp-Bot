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

  // Database — PostgreSQL External (primary)
  PG_HOST: Joi.string().allow('', null).default(''),
  PG_PORT: Joi.number().integer().default(5432),
  PG_DATABASE: Joi.string().default('idrac_bot'),
  PG_USERNAME: Joi.string().allow('', null).default(''),
  PG_PASSWORD: Joi.string().allow('', null).default(''),

  // Database — PostgreSQL Internal / memories-db (fallback, pengganti SQLite)
  MEM_PG_HOST: Joi.string().allow('', null).default('memories-db'),
  MEM_PG_PORT: Joi.number().integer().default(5432),
  MEM_PG_DATABASE: Joi.string().default('erina_memories'),
  MEM_PG_USERNAME: Joi.string().allow('', null).default('erina'),
  MEM_PG_PASSWORD: Joi.string().allow('', null).default(''),

  // Alert System
  ALERT_POLL_INTERVAL: Joi.number().integer().min(10).default(60),
  ALERT_TEMP_THRESHOLD: Joi.number().integer().default(75),
  ALERT_ENABLED: Joi.boolean().default(true),

  // Erina AI (HuggingFace Spaces)
  ERINA_ENABLED: Joi.boolean().default(false),
  ERINA_HF_TOKEN: Joi.string().allow('', null).default(''),
  ERINA_HF_SPACE: Joi.string().default('Yuuki0/Erina-Delvra-Foren'),
  ERINA_TIMEOUT: Joi.number().integer().min(5000).default(180000),
  ERINA_MAX_TOKENS: Joi.number().integer().min(64).max(2048).default(512),
  ERINA_TEMPERATURE: Joi.number().min(0.1).max(2.0).default(0.7),

  // RAG Memory (pgvector)
  ERINA_MEMORY_LIMIT: Joi.number().integer().min(1).max(20).default(5),
  ERINA_RECENT_CONTEXT: Joi.number().integer().min(0).max(10).default(3),

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
    fallback: {
      host: envVars.MEM_PG_HOST,
      port: envVars.MEM_PG_PORT,
      database: envVars.MEM_PG_DATABASE,
      username: envVars.MEM_PG_USERNAME,
      password: envVars.MEM_PG_PASSWORD,
      get isConfigured() {
        return !!(envVars.MEM_PG_HOST && envVars.MEM_PG_USERNAME && envVars.MEM_PG_PASSWORD);
      },
    },
  },



  alert: {
    pollInterval: envVars.ALERT_POLL_INTERVAL,
    tempThreshold: envVars.ALERT_TEMP_THRESHOLD,
    enabled: envVars.ALERT_ENABLED,
  },

  erina: {
    enabled: envVars.ERINA_ENABLED,
    hfToken: envVars.ERINA_HF_TOKEN,
    hfSpace: envVars.ERINA_HF_SPACE,
    timeout: envVars.ERINA_TIMEOUT,
    maxTokens: envVars.ERINA_MAX_TOKENS,
    temperature: envVars.ERINA_TEMPERATURE,
    memoryLimit: envVars.ERINA_MEMORY_LIMIT,
    recentContext: envVars.ERINA_RECENT_CONTEXT,
  },

  log: {
    level: envVars.LOG_LEVEL,
  },
};

export default config;
