/**
 * Redis Service — conditional Redis client.
 * Only connects when REDIS_ENABLED=true.
 */

import Redis from 'ioredis';
import config from '../config.js';
import logger from './logger.js';

let redisClient = null;
let isConnected = false;

/**
 * Initialize Redis connection (if enabled).
 */
function initRedis() {
  if (!config.redis.enabled) {
    logger.info('Redis disabled (REDIS_ENABLED=false)');
    return null;
  }

  redisClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username || undefined,
    password: config.redis.password || undefined,
    db: config.redis.db,
    keyPrefix: config.redis.prefix || 'idrac:',
    retryStrategy: (times) => {
      if (times > 5) {
        logger.error('Redis max retries exceeded');
        return null; // Stop retrying
      }
      return Math.min(times * 500, 3000);
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  redisClient.on('connect', () => {
    isConnected = true;
    logger.info(`✅ Redis connected → ${config.redis.host}:${config.redis.port}`);
  });

  redisClient.on('error', (err) => {
    isConnected = false;
    logger.error({ err: err.message }, 'Redis error');
  });

  redisClient.on('close', () => {
    isConnected = false;
    logger.warn('Redis connection closed');
  });

  // Connect (non-blocking)
  redisClient.connect().catch((err) => {
    logger.warn({ err: err.message }, '⚠️  Redis connection failed (will retry)');
  });

  return redisClient;
}

/**
 * Get the Redis client instance.
 */
function getRedis() {
  return redisClient;
}

/**
 * Check if Redis is connected.
 */
function isRedisConnected() {
  return isConnected;
}

/**
 * Close Redis connection.
 */
async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
    logger.info('Redis connection closed');
  }
}

export { initRedis, getRedis, isRedisConnected, closeRedis };
