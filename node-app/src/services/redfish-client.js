/**
 * Redfish Client — HTTP bridge from Node.js to Python FastAPI.
 *
 * All iDRAC communication goes through Python.
 * This module provides a clean async interface for Node routes.
 *
 * The target URL is configured via PY_API_URL in .env:
 *   Docker:    http://python-api:8000
 *   Local dev: http://localhost:8000
 */

import config from '../config.js';
import logger from './logger.js';

const BASE_URL = config.pythonApi.url;
const TIMEOUT = 30_000; // 30 seconds

/**
 * Make a request to the Python Redfish API.
 */
async function redfishRequest(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const startTime = Date.now();

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT),
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const resp = await fetch(url, options);
    const data = await resp.json();
    const elapsed = Date.now() - startTime;

    logger.debug({ method, path, status: resp.status, elapsed }, 'Redfish API call');

    if (!resp.ok) {
      throw new RedfishBridgeError(
        data?.message || `Redfish API error: ${resp.status}`,
        resp.status,
        data,
      );
    }

    return data;
  } catch (err) {
    if (err instanceof RedfishBridgeError) throw err;

    const elapsed = Date.now() - startTime;
    logger.error({ method, path, elapsed, err: err.message }, 'Redfish API call failed');

    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new RedfishBridgeError('Python API timeout', 504);
    }

    throw new RedfishBridgeError(
      `Python API unreachable: ${err.message}`,
      503,
    );
  }
}

class RedfishBridgeError extends Error {
  constructor(message, statusCode = 500, data = null) {
    super(message);
    this.name = 'RedfishBridgeError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

// ── High-level API methods ─────────────────────────

const redfishClient = {
  // Health & System
  async getHealth() {
    return redfishRequest('GET', '/health');
  },

  async getSystem() {
    return redfishRequest('GET', '/system');
  },

  // Power
  async getPowerState() {
    return redfishRequest('GET', '/power');
  },

  async getPowerDetails() {
    return redfishRequest('GET', '/power/details');
  },

  async powerOn() {
    return redfishRequest('POST', '/power/on');
  },

  async powerOff(force = false) {
    return redfishRequest('POST', '/power/off', { force });
  },

  async powerReset(force = false) {
    return redfishRequest('POST', '/power/reset', { force });
  },

  // Thermal
  async getThermal() {
    return redfishRequest('GET', '/thermal');
  },

  // Storage
  async getStorage() {
    return redfishRequest('GET', '/storage');
  },

  // Logs
  async getLogs(limit = 50) {
    return redfishRequest('GET', `/logs?limit=${limit}`);
  },

  async getLatestLogs(count = 5) {
    return redfishRequest('GET', `/logs/latest?count=${count}`);
  },

  /**
   * Get a combined status snapshot (for dashboard / WA !status command).
   */
  async getFullStatus() {
    const [system, thermal] = await Promise.all([
      redfishRequest('GET', '/system'),
      redfishRequest('GET', '/thermal'),
    ]);
    return { system: system.data, thermal: thermal.data };
  },

  // Advanced Info Monitoring
  async getMemory() {
    return redfishRequest('GET', '/system/memory');
  },

  async getProcessors() {
    return redfishRequest('GET', '/system/processors');
  },

  async getNetwork() {
    return redfishRequest('GET', '/system/network');
  },

  // Advanced Actions
  async resetIdrac() {
    return redfishRequest('POST', '/actions/idrac-reset');
  },
};

export { redfishClient, RedfishBridgeError };
