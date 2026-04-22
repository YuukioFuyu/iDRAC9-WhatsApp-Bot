/**
 * Erina Memory Service — PostgreSQL pgvector RAG memory for Erina AI.
 *
 * Replaces Firestore-based chat history with semantic vector retrieval:
 * - Embeds messages locally using `Xenova/all-MiniLM-L6-v2` (ONNX, 384-dim)
 * - Stores embeddings in PostgreSQL pgvector
 * - Retrieves semantically relevant memories via cosine similarity (HNSW index)
 * - Combines RAG retrieval + recent context for optimal LLM input
 *
 * Roles:
 * - 'master' — owner (listed in WA_ALLOWED_NUMBERS)
 * - 'guest'  — unregistered users
 * - 'erina'  — AI assistant responses
 *
 * Uses the active PostgreSQL pool from db.js (External or Internal fallback).
 */

import config from '../config.js';
import logger from './logger.js';
import { getPgPool } from './db.js';

// ── Module state ───────────────────────────────────
let extractor = null;      // Feature extraction pipeline
let isInitialized = false;
let isInitializing = false;

// ── Constants ──────────────────────────────────────
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// ── pgvector Schema ────────────────────────────────
const SCHEMA_ERINA_MEMORIES = `
  CREATE TABLE IF NOT EXISTS erina_memories (
    id SERIAL PRIMARY KEY,
    role VARCHAR(20) NOT NULL CHECK(role IN ('master', 'guest', 'erina')),
    content TEXT NOT NULL,
    embedding vector(384),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_erina_memories_embedding
    ON erina_memories USING hnsw (embedding vector_cosine_ops);

  CREATE INDEX IF NOT EXISTS idx_erina_memories_created
    ON erina_memories (created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_erina_memories_role
    ON erina_memories (role);
`;

// ── Initialization ─────────────────────────────────

/**
 * Initialize the memory system: create table + load embedding model.
 * Must be called after initDatabase() in app.js.
 *
 * @returns {Promise<boolean>} true if fully initialized
 */
async function init() {
  // Step 1: Create table if not exists
  logger.info('🔧 [Memory Init] Step 1: Creating erina_memories table...');
  const tableOk = await initTable();
  if (!tableOk) {
    logger.warn('⚠️  Erina Memory table init failed — RAG memory disabled');
    return false;
  }
  logger.info('✅ [Memory Init] Step 1: Table ready');

  // Step 2: Load embedding model
  if (isInitialized) return true;
  if (isInitializing) {
    while (isInitializing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return isInitialized;
  }

  isInitializing = true;

  try {
    // ── Load embedding model ─────────────────────────
    // Using @xenova/transformers v2 — has built-in ONNX WASM runtime
    // that works on ALL architectures (x86, ARM64, MIPS).
    // No separate onnxruntime-node/web packages needed.
    logger.info(`🔧 [Memory Init] Step 2: Loading embedding model: ${MODEL_NAME}...`);
    const startTime = Date.now();

    logger.info('   → Importing @xenova/transformers...');
    const { pipeline: createPipeline, env: xenovaEnv } = await import('@xenova/transformers');
    logger.info('   → Import OK');

    const cacheDir = process.env.TRANSFORMERS_CACHE || './data/models';
    logger.info(`   → Cache dir: ${cacheDir}`);

    // Configure Xenova environment
    xenovaEnv.cacheDir = cacheDir;
    xenovaEnv.allowLocalModels = true;
    xenovaEnv.allowRemoteModels = true;

    // Limit ONNX threads for resource-constrained environments (MikroTik)
    if (xenovaEnv.backends?.onnx?.wasm) {
      xenovaEnv.backends.onnx.wasm.numThreads = 1;
      logger.info('   → WASM threads limited to 1');
    }

    logger.info('   → Creating pipeline (this may download the model on first run)...');
    extractor = await createPipeline('feature-extraction', MODEL_NAME, {
      quantized: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ [Memory Init] Step 2: Embedding model loaded in ${elapsed}s (${MODEL_NAME}, ${EMBEDDING_DIM}-dim)`);

    isInitialized = true;
    return true;
  } catch (err) {
    logger.error(
      { err: err.message, stack: err.stack },
      '❌ [Memory Init] Step 2 FAILED — embedding model could not load. RAG memory disabled.'
    );
    isInitialized = false;
    return false;
  } finally {
    isInitializing = false;
  }
}

/**
 * Create the erina_memories table with pgvector support.
 * Uses the active pool from db.js (External or Internal).
 */
async function initTable() {
  const pool = getPgPool();
  if (!pool) {
    logger.warn('⚠️  No database pool available — cannot init erina_memories');
    return false;
  }

  const client = await pool.connect();
  try {
    // Ensure pgvector extension exists
    const extCheck = await client.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    );
    if (extCheck.rows.length === 0) {
      // Try creating it (works on memories-db container, may fail on external)
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        logger.info('✅ pgvector extension created');
      } catch (extErr) {
        logger.warn('⚠️  pgvector extension not found — run: CREATE EXTENSION vector;');
        return false;
      }
    }

    await client.query(SCHEMA_ERINA_MEMORIES);
    logger.info('✅ Erina Memory table ready (pgvector HNSW)');
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to init erina_memories table');
    return false;
  } finally {
    client.release();
  }
}

// ── Embedding ──────────────────────────────────────

/**
 * Generate a 384-dimensional embedding vector from text.
 *
 * @param {string} text - Input text to embed
 * @returns {Promise<number[]>} 384-dim embedding vector
 */
async function embedText(text) {
  if (!isInitialized || !extractor) {
    throw new Error('Embedding model not initialized — call init() first');
  }

  // Truncate very long texts to avoid excessive compute (model max ~256 tokens)
  const truncated = text.length > 1000 ? text.substring(0, 1000) : text;

  const output = await extractor(truncated, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data);
}

// ── Memory Operations ──────────────────────────────

/**
 * Save a message + its embedding to PostgreSQL erina_memories table.
 *
 * @param {string} role - 'master', 'guest', or 'erina'
 * @param {string} content - Message text
 * @param {object} metadata - Optional metadata (userName, intent, etc.)
 */
async function saveMemory(role, content, metadata = {}) {
  const pool = getPgPool();
  if (!pool || !isInitialized) {
    if (!isInitialized) {
      logger.debug('saveMemory skipped — embedding model not initialized');
    }
    return;
  }

  try {
    const embedding = await embedText(content);
    const embeddingStr = `[${embedding.join(',')}]`;

    await pool.query(
      `INSERT INTO erina_memories (role, content, embedding, metadata)
       VALUES ($1, $2, $3::vector, $4)`,
      [role, content, embeddingStr, JSON.stringify(metadata)]
    );

    logger.debug({ role, contentLen: content.length }, 'Memory saved');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to save memory');
  }
}

/**
 * Retrieve the most semantically relevant memories for a query.
 *
 * @param {string} queryText - The query text to find relevant memories for
 * @param {number} limit - Maximum number of memories to return
 * @returns {Promise<Array<{role: string, content: string, created_at: string, similarity: number}>>}
 */
async function retrieveRelevant(queryText, limit = config.erina.memoryLimit) {
  const pool = getPgPool();
  if (!pool || !isInitialized) return [];

  try {
    const embedding = await embedText(queryText);
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await pool.query(
      `SELECT role, content, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM erina_memories
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingStr, limit]
    );

    return result.rows;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to retrieve relevant memories');
    return [];
  }
}

/**
 * Get the N most recent messages in chronological order.
 *
 * @param {number} limit - Number of recent messages to fetch
 * @returns {Promise<Array<{role: string, content: string, created_at: string}>>}
 */
async function getRecentContext(limit = config.erina.recentContext) {
  const pool = getPgPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT role, content, created_at
       FROM erina_memories
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.reverse();
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get recent context');
    return [];
  }
}

/**
 * Check if the same user message was recently sent and already has a response.
 *
 * @param {string} message - The user message to check
 * @returns {Promise<string|null>} The assistant's cached response, or null
 */
async function checkDuplicate(message) {
  const pool = getPgPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `WITH recent_user AS (
         SELECT id, content, created_at
         FROM erina_memories
         WHERE role IN ('master', 'guest')
           AND content = $1
           AND created_at > NOW() - INTERVAL '10 minutes'
         ORDER BY created_at DESC
         LIMIT 1
       )
       SELECT em.content AS response
       FROM recent_user ru
       JOIN erina_memories em
         ON em.role = 'erina'
         AND em.id > ru.id
         AND em.created_at <= ru.created_at + INTERVAL '10 minutes'
       ORDER BY em.created_at ASC
       LIMIT 1`,
      [message]
    );

    if (result.rows.length > 0) {
      return result.rows[0].response;
    }

    return null;
  } catch (err) {
    logger.debug({ err: err.message }, 'Duplicate check failed — proceeding normally');
    return null;
  }
}

/**
 * Build the chat_history array for Gradio API.
 * Combines RAG-retrieved relevant memories + recent chronological context,
 * deduplicates, and formats as [{role, content}, ...].
 *
 * Note: roles are mapped back to 'user'/'assistant' for Gradio compatibility.
 *
 * @param {string} message - Current user message
 * @param {number} [memoryLimit] - Max RAG memories to retrieve (default: config)
 * @param {number} [recentLimit] - Max recent messages to fetch (default: config)
 * @returns {Promise<Array<{role: string, content: string}>>} Chat history for LLM
 */
async function buildChatHistory(message, memoryLimit, recentLimit) {
  const pool = getPgPool();
  if (!pool || !isInitialized) return [];

  try {
    const [relevant, recent] = await Promise.all([
      retrieveRelevant(message, memoryLimit ?? config.erina.memoryLimit),
      getRecentContext(recentLimit ?? config.erina.recentContext),
    ]);

    const seen = new Set();
    const merged = [];

    // Map DB roles back to LLM roles for Gradio
    const toLlmRole = (role) => (role === 'erina' ? 'assistant' : 'user');

    // Recent context first (temporal continuity)
    for (const mem of recent) {
      const key = `${mem.role}:${mem.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ role: toLlmRole(mem.role), content: mem.content });
      }
    }

    // Then RAG-retrieved (semantic relevance)
    for (const mem of relevant) {
      const key = `${mem.role}:${mem.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ role: toLlmRole(mem.role), content: mem.content });
      }
    }

    logger.debug(
      { relevantCount: relevant.length, recentCount: recent.length, mergedCount: merged.length },
      'Chat history built'
    );

    return merged;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to build chat history');
    return [];
  }
}

/**
 * Check if the memory service is available and ready.
 */
function isReady() {
  return isInitialized && !!getPgPool();
}

export {
  init,
  embedText,
  saveMemory,
  retrieveRelevant,
  getRecentContext,
  checkDuplicate,
  buildChatHistory,
  isReady,
};
