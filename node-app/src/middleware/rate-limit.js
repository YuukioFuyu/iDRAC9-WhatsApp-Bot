/**
 * Rate Limiter — per-number command rate limiting for WhatsApp.
 * Uses in-memory sliding window.
 */

import config from '../config.js';
import logger from '../services/logger.js';

class RateLimiter {
  constructor() {
    this.windows = new Map(); // number → [timestamps]
    this.maxPerMinute = config.whatsapp.rateLimit;

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Check if a number is rate limited.
   * @param {string} number - WhatsApp number (e.g., '628xxx')
   * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
   */
  check(number) {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const cutoff = now - windowMs;

    // Get or create window
    let timestamps = this.windows.get(number) || [];

    // Remove expired entries
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.maxPerMinute) {
      const oldestInWindow = timestamps[0];
      const resetIn = Math.ceil((oldestInWindow + windowMs - now) / 1000);

      logger.warn(
        { number, count: timestamps.length, maxPerMinute: this.maxPerMinute },
        'Rate limit hit'
      );

      return {
        allowed: false,
        remaining: 0,
        resetIn,
      };
    }

    // Record this request
    timestamps.push(now);
    this.windows.set(number, timestamps);

    return {
      allowed: true,
      remaining: this.maxPerMinute - timestamps.length,
      resetIn: 0,
    };
  }

  /**
   * Cleanup old windows to prevent memory leak.
   */
  cleanup() {
    const cutoff = Date.now() - 120_000; // 2 minutes ago
    for (const [number, timestamps] of this.windows.entries()) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.windows.delete(number);
      } else {
        this.windows.set(number, active);
      }
    }
  }
}

// Singleton
const rateLimiter = new RateLimiter();
export default rateLimiter;
