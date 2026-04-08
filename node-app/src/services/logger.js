/**
 * Logger — Pino structured logging with pretty output in development.
 */

import pino from 'pino';
import config from '../config.js';

const logger = pino({
  level: config.log.level,
  transport: config.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Production: JSON output for log aggregation
  ...(config.isDev
    ? {}
    : {
        formatters: {
          level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

export default logger;
