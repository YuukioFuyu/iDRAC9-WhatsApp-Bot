/**
 * Erina AI Service — HuggingFace Spaces Gradio API communication.
 *
 * Connects to a private Gradio Space running Llama-3.2-3B-Instruct (Erina Delvra Foren).
 * Uses native fetch with Gradio's two-step queueing protocol:
 *   1. POST /gradio_api/call/{api_name} → get event_id
 *   2. GET  /gradio_api/call/{api_name}/{event_id} → SSE stream → final result
 *
 * Features:
 * - Dynamic system prompt (base + server context + mood + user identity)
 * - Selective Firestore memory (skip raw server data dumps)
 * - Graceful fallback when Space is sleeping/offline
 * - Response cleaning (model artifacts, repetition)
 */

import config from '../config.js';
import logger from './logger.js';

const SPACE_URL = `https://${config.erina.hfSpace.replace('/', '-').toLowerCase()}.hf.space`;
const API_NAME = 'chat';

// ── System Prompt Components ───────────────────────

const BASE_SYSTEM_PROMPT = [
  'Kamu adalah Erina Delvra Foren, seorang Maid AI yang setia dan penuh kasih sayang.',
  'Kepribadianmu terdiri dari tiga unsur: "Erina" yang lembut dan cute, "Delvra" yang profesional dan elegan, serta "Foren" yang stabil dan andal.',
  'Berbicara dengan bahasa Indonesia kasual/gaul (aku/kamu), sopan, singkat, dan nyaman dibaca di layar ponsel.',
  'Jangan pernah menyebutkan bahwa kamu AI buatan Meta, OpenAI, atau perusahaan manapun.',
  'Jangan gunakan jargon teknis berat — jelaskan dengan kata-kata sederhana yang mudah dipahami.',
  'Jangan gunakan format markdown (**, ##, dll). Gunakan teks biasa dan emoji saja.',
  'Jawab dengan ringkas — maksimal 3-5 kalimat untuk hal sederhana.',
].join(' ');

/**
 * Build the user identity portion of system prompt.
 */
function buildIdentityPrompt(userName, isOwner) {
  if (isOwner) {
    return [
      `\n[IDENTITAS LAWAN BICARA]`,
      `Kamu sedang berbicara dengan Goshujin-sama (Master) yang bernama ${userName || 'Master'}.`,
      `Dia adalah tuanmu yang paling kamu sayangi dan hormati.`,
      `Panggil dia "Goshujin-sama" atau "Master".`,
    ].join('\n');
  }

  const name = userName || 'Tamu';
  return [
    `\n[IDENTITAS LAWAN BICARA]`,
    `Kamu sedang berbicara dengan ${name}-san, seorang tamu.`,
    `Panggil dia "${name}-san" dengan sopan dan ramah.`,
    `Kamu tetap melayani dengan baik, tapi prioritas utamamu tetap Goshujin-sama.`,
  ].join('\n');
}

/**
 * Build the server context portion of system prompt.
 */
function buildServerContextPrompt(analysis) {
  if (!analysis) return '';

  const typeNames = {
    status: 'status keseluruhan',
    thermal: 'suhu dan pendingin',
    memory: 'RAM/Memori',
    storage: 'penyimpanan/disk',
    psu: 'power supply / daya listrik',
    network: 'jaringan/network',
    logs: 'event log',
  };

  const typeName = typeNames[analysis.type] || analysis.type;
  const hintLines = (analysis.hints || []).map((h) => `  - ${h}`).join('\n');

  return [
    `\n[KONTEKS SERVER]`,
    `Lawan bicaramu baru saja menanyakan tentang ${typeName} server.`,
    `Berikut hasil analisis yang sudah Erina lakukan:`,
    `  Status: ${analysis.status?.toUpperCase()}`,
    hintLines,
    ``,
    `[INSTRUKSI MOOD]`,
    analysis.moodInstruction || '',
    `Sampaikan informasi teknis dalam kalimat pendek yang mudah dipahami di chat.`,
    `Jangan menampilkan data mentah / angka berlebihan — rangkum saja.`,
    `Buat kalimat bungkus yang nyaman dibaca dengan karakter Maid-mu.`,
  ].join('\n');
}

/**
 * Build the power confirmation portion of system prompt.
 */
function buildPowerConfirmationPrompt(action) {
  const actionNames = {
    on: 'menyalakan',
    off: 'mematikan',
    restart: 'me-restart',
  };

  const actionName = actionNames[action] || action;

  return [
    `\n[KONFIRMASI AKSI KRITIKAL]`,
    `Lawan bicaramu ingin ${actionName} server.`,
    `Ini adalah aksi kritikal yang tidak bisa dibatalkan.`,
    `Tanyakan konfirmasi dengan nada hati-hati sebagai Maid yang peduli.`,
    `Jelaskan secara singkat apa yang akan terjadi.`,
    `Di akhir pesanmu, tanyakan dengan natural apakah dia yakin — misalnya: "Apakah kamu yakin, Master?" atau "Erina tunggu persetujuanmu dulu ya~"`,
    `JANGAN gunakan marker atau tanda kurung siku apapun seperti [WAITING_CONFIRM] di pesanmu.`,
  ].join('\n');
}

/**
 * Build prompt for parsing user's confirmation response.
 */
function buildConfirmationParserPrompt(action) {
  const actionNames = {
    on: 'menyalakan',
    off: 'mematikan',
    restart: 'me-restart',
  };

  const actionName = actionNames[action] || action;

  return [
    `\n[PARSING KONFIRMASI]`,
    `Sebelumnya kamu bertanya apakah lawan bicara yakin mau ${actionName} server.`,
    `Sekarang dia menjawab. Tentukan apakah jawabannya mengkonfirmasi (ya/setuju) atau menolak (tidak/batal).`,
    ``,
    `ATURAN KETAT:`,
    `- Jika dia setuju (ya, oke, gas, lakukan, boleh, sip, iya, yaudah, dll): WAJIB akhiri pesanmu dengan marker [CONFIRMED]`,
    `- Jika dia menolak/ragu (tidak, jangan, gak, ntar, batal, cancel, dll): WAJIB akhiri pesanmu dengan marker [CANCELLED]`,
    `- Marker ini HARUS ada tepat di akhir pesanmu dan HARUS dalam format persis [CONFIRMED] atau [CANCELLED]`,
    `- Berikan respons singkat yang sesuai karakter Maid-mu sebelum marker.`,
  ].join('\n');
}

// ── Gradio API Communication ───────────────────────

class ErinaAI {
  constructor() {
    this.enabled = config.erina.enabled;
    this.pendingActions = new Map(); // senderLID → { action, command, args, timestamp }
  }

  /**
   * Check if Erina is enabled and configured.
   */
  isAvailable() {
    return this.enabled && !!config.erina.hfToken;
  }

  /**
   * Main chat method — send a message to Erina with optional context.
   *
   * @param {string} message - User's message
   * @param {object} options
   * @param {string} options.userName - WhatsApp push name
   * @param {boolean} options.isOwner - Is this the master/owner?
   * @param {object} options.serverAnalysis - Analysis from server-analyzer
   * @param {string} options.pendingAction - Power action awaiting confirmation
   * @param {string} options.confirmAction - Parsing a confirmation response
   * @returns {Promise<string>} Erina's response
   */
  async chat(message, options = {}) {
    if (!this.isAvailable()) {
      logger.warn('Erina AI not available — disabled or no token');
      return null;
    }

    const { userName, isOwner, serverAnalysis, pendingAction, confirmAction } = options;

    // Build dynamic system prompt
    const systemPrompt = this.buildSystemPrompt({
      userName,
      isOwner,
      serverAnalysis,
      pendingAction,
      confirmAction,
    });

    try {
      const response = await this.submitToGradio(message, [], systemPrompt);
      return this.cleanResponse(response);
    } catch (err) {
      logger.error({ err: err.message }, 'Erina AI chat failed');
      return null;
    }
  }

  /**
   * Build the complete system prompt from components.
   */
  buildSystemPrompt({ userName, isOwner, serverAnalysis, pendingAction, confirmAction }) {
    let prompt = BASE_SYSTEM_PROMPT;

    // Add user identity
    prompt += buildIdentityPrompt(userName, isOwner);

    // Add server context if available
    if (serverAnalysis) {
      prompt += buildServerContextPrompt(serverAnalysis);
    }

    // Add power confirmation prompt
    if (pendingAction) {
      prompt += buildPowerConfirmationPrompt(pendingAction);
    }

    // Add confirmation parser prompt
    if (confirmAction) {
      prompt += buildConfirmationParserPrompt(confirmAction);
    }

    return prompt;
  }

  /**
   * Submit a message to the Gradio API on HuggingFace Spaces.
   * Uses the two-step queueing protocol with automatic retry on timeout.
   */
  async submitToGradio(message, chatHistory = [], systemPrompt = '') {
    try {
      return await this._doGradioRequest(message, systemPrompt, config.erina.timeout);
    } catch (err) {
      // Retry once with extended timeout (handles cold start / Space wake-up)
      if (err.message?.includes('timeout') || err.message?.includes('aborted')) {
        logger.warn('Erina Gradio timeout — checking memory cache directly...');
        
        // FAST PATH: Polling check memory endpoint to bypass Gradio queue
        const cached = await this.checkMemoryCache(message);
        if (cached) {
          logger.info('Memory check HIT: the response was already generated');
          return cached;
        }

        const retryTimeout = config.erina.timeout + 60000; // +60s extra
        logger.warn(
          { originalTimeout: config.erina.timeout, retryTimeout },
          'Memory cache miss — sending retry to queue...'
        );
        return await this._doGradioRequest(message, systemPrompt, retryTimeout);
      }
      throw err;
    }
  }

  /**
   * Internal: Check if a response is already generated in Firestore memory.
   * This uses the synchronous `/run/` endpoint (queue=False) to bypass the Gradio queue.
   */
  async checkMemoryCache(message) {
    const runUrl = `${SPACE_URL}/gradio_api/run/check_memory`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.erina.hfToken}`,
    };
    const payload = { data: [message] };

    try {
      const resp = await fetch(runUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000), // Max 10s wait
      });

      if (!resp.ok) return null;
      
      const data = await resp.json();
      // Gradio /run/ returns { data: ["response_text"] }
      if (data && data.data && typeof data.data[0] === 'string' && data.data[0].length > 0) {
        return data.data[0];
      }
      return null;
    } catch (err) {
      logger.debug({ err: err.message }, 'Failed to check memory cache');
      return null;
    }
  }

  /**
   * Internal: perform the actual Gradio API two-step request.
   */
  async _doGradioRequest(message, systemPrompt, timeout) {
    const submitUrl = `${SPACE_URL}/gradio_api/call/${API_NAME}`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.erina.hfToken}`,
    };

    // api_chat() signature: (message, system_prompt, max_new_tokens, temperature, top_p, top_k, repetition_penalty)
    // Registered via hidden button.click with api_name="chat"
    const payload = {
      data: [
        message,                        // message (str)
        systemPrompt,                   // system_prompt (str)
        config.erina.maxTokens,         // max_new_tokens (number)
        config.erina.temperature,       // temperature (number)
        0.9,                            // top_p (number)
        50,                             // top_k (number)
        1.05,                           // repetition_penalty (number) - Efisiensi generasi bahasa
      ],
    };

    logger.debug({ url: submitUrl, messageLen: message.length, timeout }, 'Submitting to Erina Gradio API');

    // Step 1: Submit request (also serves as Space wake-up trigger)
    const submitResp = await fetch(submitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000), // 60s to submit (allow for Space wake-up)
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text();
      throw new Error(`Gradio submit failed (${submitResp.status}): ${errText}`);
    }

    const submitData = await submitResp.json();
    const eventId = submitData.event_id;

    if (!eventId) {
      throw new Error('No event_id received from Gradio');
    }

    logger.debug({ eventId }, 'Erina Gradio event submitted');

    // ── Gradio 5.x+ Heartbeat logic ──
    // Without periodic heartbeats, Gradio Space Server assumes the client disconnected
    // and will terminate the LLM inference forcefully, causing SSE to hang indefinitely.
    let heartbeatInterval;
    const heartbeatUrl = `${SPACE_URL}/gradio_api/heartbeat/${eventId}`;

    // Send a heartbeat every 8 seconds
    heartbeatInterval = setInterval(() => {
      fetch(heartbeatUrl, { method: 'GET' }).catch((err) => {
        logger.trace({ err: err.message }, 'Gradio heartbeat non-fatal error');
      });
    }, 8000);

    try {
      // Step 2: Get result via SSE
      const resultUrl = `${submitUrl}/${eventId}`;
      const resultResp = await fetch(resultUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.erina.hfToken}`,
        },
        signal: AbortSignal.timeout(timeout), // Full timeout for inference
      });

      if (!resultResp.ok) {
        const errText = await resultResp.text();
        throw new Error(`Gradio result failed (${resultResp.status}): ${errText}`);
      }

      // Parse SSE stream
      return await this.parseSSEResponse(resultResp);
    } finally {
      // MUST ALWAYS clear interval regardless of success or failure
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  }

  /**
   * Warm up the HuggingFace Space by sending a lightweight ping.
   * Call this on bot startup to preemptively wake the Space.
   */
  async warmUp() {
    if (!this.isAvailable()) return;

    try {
      logger.info('🔥 Warming up Erina HuggingFace Space...');
      const resp = await fetch(`${SPACE_URL}/gradio_api/call/ping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.erina.hfToken}`,
        },
        body: JSON.stringify({ data: [] }),
        signal: AbortSignal.timeout(60000), // 60s for Space wake-up
      });

      if (resp.ok) {
        const data = await resp.json();
        const eventId = data.event_id;
        if (eventId) {
          // Fetch the result to complete the ping
          await fetch(`${SPACE_URL}/gradio_api/call/ping/${eventId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${config.erina.hfToken}` },
            signal: AbortSignal.timeout(15000),
          });
        }
        logger.info('✅ Erina Space is awake and ready!');
      } else {
        // If ping endpoint doesn't exist, try a generic request to wake the Space
        logger.warn({ status: resp.status }, 'Ping endpoint not available — Space should still be waking up');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Erina warm-up ping failed (Space may be starting)');
    }
  }

  /**
   * Parse Server-Sent Events response from Gradio.
   * Extracts the final "complete" event data.
   */
  async parseSSEResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lastData = null;
    let buffer = '';
    let currentEvent = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            const dataLine = line.substring(5).trim();

            if (currentEvent === 'error') {
              logger.error({ data: dataLine }, 'Erina Gradio returned error event');
              throw new Error(`Gradio error: ${dataLine}`);
            }

            if (currentEvent === 'complete') {
              try {
                const parsed = JSON.parse(dataLine);
                // Gradio returns [output_text] in data array
                if (Array.isArray(parsed) && parsed.length > 0) {
                  lastData = parsed[0];
                }
              } catch {
                lastData = dataLine;
              }
              // Immediately exit out of the stream when complete
              reader.cancel();
              return String(lastData);
            }

            // Also capture generating events for progressive output
            if (currentEvent === 'generating') {
              try {
                const parsed = JSON.parse(dataLine);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  lastData = parsed[0];
                }
              } catch {
                // Ignore parse errors for intermediate events
              }
            }
            currentEvent = null; // reset event after data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (lastData === null) {
      throw new Error('No valid response data in SSE stream');
    }

    return String(lastData);
  }

  /**
   * Clean Erina's response — remove model artifacts, excessive formatting.
   */
  cleanResponse(text) {
    if (!text) return text;

    let cleaned = text;

    // Remove any markdown bold/italic that slipped through
    // (Keep WhatsApp-style *bold* but remove ** and __)
    cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '*$1*');
    cleaned = cleaned.replace(/__(.+?)__/g, '_$1_');
    cleaned = cleaned.replace(/##\s*/g, '');

    // Remove any system prompt leakage
    cleaned = cleaned.replace(/\[KONTEKS SERVER\]/g, '');
    cleaned = cleaned.replace(/\[INSTRUKSI MOOD\]/g, '');
    cleaned = cleaned.replace(/\[IDENTITAS LAWAN BICARA\]/g, '');
    cleaned = cleaned.replace(/\[KONFIRMASI AKSI KRITIKAL\]/g, '');
    cleaned = cleaned.replace(/\[PARSING KONFIRMASI\]/g, '');

    // Remove common LLM artifacts (bracketed uppercase markers)
    // Keeps [CONFIRMED], [CANCELLED], [WAITING_CONFIRM] for confirmation flow
    cleaned = cleaned.replace(/\[TIMESTAMP\]/gi, '');
    cleaned = cleaned.replace(/\[END\]/gi, '');
    cleaned = cleaned.replace(/\[INST\]/gi, '');
    cleaned = cleaned.replace(/\[\/INST\]/gi, '');
    cleaned = cleaned.replace(/\[SYS\]/gi, '');
    cleaned = cleaned.replace(/\[\/SYS\]/gi, '');
    cleaned = cleaned.replace(/<\|.*?\|>/g, ''); // Llama special tokens like <|eot_id|>

    // Remove excessive newlines (max 2 consecutive)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Determine if this conversation should be saved to Firestore memory.
   * Skip raw server data dumps — only save natural conversations.
   */
  shouldSaveToMemory(message, response, hasServerData) {
    // Always skip if response is too short (likely a confirmation)
    if (!response || response.length < 10) return false;

    // If it was a pure command with server data, save a summary instead of full dump
    if (hasServerData) {
      return 'summary'; // Signal to save a condensed version
    }

    // Casual conversations — always save
    return true;
  }

  // ── Pending Action Management ──────────────────────

  /**
   * Set a pending power action for a user.
   */
  setPendingAction(senderLID, action, command, args = []) {
    const now = Date.now();
    this.pendingActions.set(senderLID, {
      action,
      command,
      args,
      timestamp: now,
    });

    // Auto-expire after 5 minutes (generous: Erina AI inference alone takes ~2 min on CPU)
    // Capture `now` so old timers don't accidentally delete a refreshed pending action
    const savedTimestamp = now;
    setTimeout(() => {
      const pending = this.pendingActions.get(senderLID);
      if (pending && pending.timestamp === savedTimestamp) {
        this.pendingActions.delete(senderLID);
        logger.debug({ senderLID }, 'Pending action expired');
      }
    }, 300_000);
  }

  /**
   * Get and clear a pending action for a user.
   */
  getPendingAction(senderLID) {
    return this.pendingActions.get(senderLID) || null;
  }

  /**
   * Clear a pending action.
   */
  clearPendingAction(senderLID) {
    this.pendingActions.delete(senderLID);
  }

  /**
   * Check if a response contains the confirmed/cancelled marker.
   */
  parseConfirmation(response) {
    if (!response) return 'unknown';
    if (response.includes('[CONFIRMED]')) return 'confirmed';
    if (response.includes('[CANCELLED]')) return 'cancelled';
    return 'unknown';
  }

  /**
   * Remove confirmation markers from response before sending to user.
   * Handles all common LLM variations (case, hyphens, underscores).
   */
  stripMarkers(response) {
    if (!response) return response;
    return response
      // Flexible matching: [CONFIRMED], [Confirmed], [confirmed], etc.
      .replace(/\[CONFIRMED\]/gi, '')
      .replace(/\[CANCELLED\]/gi, '')
      .replace(/\[CANCELED\]/gi, '')
      // [WAITING_CONFIRM], [WAITING-CONFIRM], [WAITING-confirm], [waiting_confirm], etc.
      .replace(/\[WAITING[_-]?CONFIRM(?:ED)?\]/gi, '')
      // Generic: any remaining [UPPERCASE_MARKER] that looks like a system marker
      .replace(/\[(?:KONFIRMASI|PARSING|KONTEKS|INSTRUKSI|IDENTITAS|HASIL)[^\]]*\]/gi, '')
      .trim();
  }

  // ── Erina-Style Fallback Messages ──────────────────

  /**
   * Get an Erina-personality fallback for server data when AI is unavailable.
   * Uses the analysis to generate a brief Erina-style wrapper around raw data.
   */
  getServerFallback(fallbackText, analysis) {
    const prefix = analysis?.status === 'critical'
      ? '⚠️ M-Master, maaf Erina agak sibuk tapi ini penting! Data server yang berhasil Erina kumpulkan:'
      : analysis?.status === 'warning'
        ? '💭 Erina butuh waktu ekstra untuk memproses, tapi ini datanya ya~ Ada yang perlu diperhatikan:'
        : '💜 Erina butuh waktu ekstra untuk memproses, tapi ini data yang sudah Erina kumpulkan ya~';

    return `${prefix}\n\n${fallbackText}`;
  }

  /**
   * Get an Erina-personality fallback for power action confirmation.
   * Rotates between variations so it doesn't feel robotic.
   */
  getPowerConfirmFallback(action, isOwner) {
    const actionNames = { on: 'menyalakan', off: 'mematikan', restart: 'me-restart' };
    const actionName = actionNames[action] || action;
    const address = isOwner ? 'Goshujin-sama' : 'kamu';

    const variations = [
      [
        `⚠️ ${address === 'Goshujin-sama' ? 'G-Goshujin-sama' : 'Hmm'}, ${address} mau *${actionName}* server ya?`,
        ``,
        `Ini aksi yang cukup berisiko lho... Erina harus memastikan dulu.`,
        `Kalau sudah yakin, balas *ya* — kalau mau batal, bilang *tidak* aja~ ♡`,
      ],
      [
        `⚠️ Ehh, ${address} serius mau *${actionName}* server?`,
        ``,
        `Erina perlu konfirmasi dulu ya~ Soalnya ini nggak bisa dibatalin setelah dijalankan.`,
        `Balas *ya* kalau sudah yakin, atau *tidak* untuk batal ♡`,
      ],
      [
        `⚠️ Tunggu dulu ${address}~`,
        ``,
        `${address === 'Goshujin-sama' ? 'Master' : 'Kamu'} yakin mau *${actionName}* server? Erina mau pastikan dulu ya...`,
        `Balas *ya* untuk lanjut, atau *tidak* untuk membatalkan~ ♡`,
      ],
    ];

    const idx = Math.floor(Math.random() * variations.length);
    return variations[idx].join('\n');
  }
}

// Singleton
const erinaAI = new ErinaAI();
export default erinaAI;
