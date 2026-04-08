/**
 * Intent Classifier — fuzzy keyword pre-fetch hint for Erina AI.
 *
 * This is NOT a strict gate. ALL messages always go to Erina.
 * The classifier only decides: "should we pre-fetch Redfish data?"
 *
 * Uses Levenshtein distance for typo tolerance.
 *
 * SAFETY: Power actions use EXACT match only (no fuzzy) to prevent
 * accidental server shutdowns from casual conversation.
 * "masih" ≠ "mati" — lesson learned the hard way. 💀
 */

import { COMMANDS } from './command-parser.js';

// ── Levenshtein Distance ───────────────────────────

/**
 * Calculate Levenshtein distance between two strings.
 * Used for typo tolerance in keyword matching.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Check if a word fuzzy-matches any keyword in a list.
 * Returns the matched keyword or null.
 *
 * SAFETY RULES:
 * - Words ≤ 4 chars: max distance 1 (tighter)
 * - Words 5-6 chars: max distance 1 (still tight)
 * - Words ≥ 7 chars: max distance 2 (relaxed)
 * - Must also share the same first letter to avoid wild mismatches
 */
function fuzzyMatch(word, keywords, maxDistance = 2) {
  // Exact match first (fastest)
  if (keywords.includes(word)) return word;

  // Fuzzy match (only for words ≥ 4 chars to avoid false positives)
  if (word.length < 4) return null;

  // Dynamic max distance based on word length
  // Short words get stricter matching to prevent "masih" → "mati" type disasters
  let effectiveMaxDistance;
  if (word.length <= 6) {
    effectiveMaxDistance = 1; // Very strict for short words
  } else {
    effectiveMaxDistance = Math.min(maxDistance, 2);
  }

  for (const keyword of keywords) {
    // Only fuzzy match if lengths are close enough
    if (Math.abs(word.length - keyword.length) > effectiveMaxDistance) continue;

    // Must share the same first letter (prevents wild mismatches)
    if (word[0] !== keyword[0]) continue;

    if (levenshtein(word, keyword) <= effectiveMaxDistance) return keyword;
  }

  return null;
}

// ── Word Cleaner ───────────────────────────────────

/**
 * Remove trailing punctuation from a word.
 * "erina," → "erina", "bangun?" → "bangun", "mati!" → "mati"
 */
function cleanWord(word) {
  return word.replace(/[.,!?;:~'"()\[\]{}]+$/g, '').replace(/^[.,!?;:~'"()\[\]{}]+/g, '');
}

// ── Keyword Maps ───────────────────────────────────

/**
 * STRONG server keywords — always trigger server_hint regardless of context.
 * These are unambiguously technical/server terms.
 */
const SERVER_KEYWORDS_STRONG = {
  // Thermal — technical terms only
  thermal: ['temperatur', 'temperature', 'temp', 'thermal'],
  fan: ['fan', 'kipas', 'cooling'],

  // Memory — clearly technical
  memory: ['ram', 'memori', 'memory', 'dimm', 'ddr'],

  // Storage — clearly technical
  storage: ['disk', 'hardisk', 'harddisk', 'storage', 'ssd', 'hdd', 'raid', 'drive'],

  // Network — clearly technical
  network: ['network', 'nic', 'ethernet'],

  // PSU — clearly technical
  psu: ['psu', 'watt'],

  // Logs — unambiguous
  logs: ['log', 'logs'],

  // Status
  status: ['status'],

  // iDRAC
  idrac: ['bmc', 'idrac', 'drac'],
};

/**
 * WEAK server keywords — only trigger server_hint if SERVER_CONTEXT_WORDS
 * are also present in the message. Prevents false positives like
 * "hari ini panas banget" from triggering thermal lookup.
 */
const WEAK_SERVER_KEYWORDS = {
  thermal: ['suhu', 'panas', 'dingin'],
  fan: ['angin', 'pendingin'],
  network: ['jaringan'],
  psu: ['listrik', 'adaptor'],
  logs: ['event', 'events'],
  status: ['kondisi', 'keadaan'],
};

/** Power action keywords — EXACT MATCH ONLY for safety
 *  No fuzzy matching for power actions to prevent accidental shutdowns.
 *  Each word must be an exact hit against these lists.
 */
const POWER_KEYWORDS = {
  on: ['nyalain', 'nyalakan', 'hidupkan', 'hidupin', 'poweron', 'start'],
  off: ['matiin', 'matikan', 'shutdown', 'poweroff', 'stop'],
  restart: ['restart', 'reboot', 'mulai ulang', 'restar'],
};

/** Words that confirm server-related context.
 *  Uses startsWith matching to handle Indonesian suffixes: servernya, mesinnya, dll.
 */
const SERVER_CONTEXT_ROOTS = ['server', 'mesin', 'komputer', 'host', 'sistem'];

/** Check if a word matches any server context root (handles -nya, -mu, -ku suffixes) */
function isServerContextWord(word) {
  return SERVER_CONTEXT_ROOTS.some(root => word === root || word.startsWith(root));
}

// ── Build command alias lookup ─────────────────────

const commandAliasMap = new Map();
for (const [name, cmd] of Object.entries(COMMANDS)) {
  commandAliasMap.set(name, name);
  for (const alias of cmd.aliases) {
    commandAliasMap.set(alias, name);
  }
}

// ── Topic → Command mapping ────────────────────────

const TOPIC_TO_COMMAND = {
  thermal: 'temp',
  fan: 'temp',
  memory: 'memory',
  storage: 'disk',
  network: 'network',
  psu: 'psu',
  logs: 'logs',
  status: 'status',
  idrac: 'status',
};

const POWER_ACTION_TO_COMMAND = {
  on: 'on',
  off: 'off',
  restart: 'restart',
};

// ── Main Classifier ────────────────────────────────

/**
 * Classify the intent of a WhatsApp message.
 *
 * Returns one of:
 * - { type: 'exact_command', command: 'status' }
 * - { type: 'server_hint', topic: 'memory', command: 'memory' }
 * - { type: 'power_action', action: 'off', command: 'off' }
 * - { type: 'chat' }
 *
 * ALL types still ultimately go to Erina.
 * 'exact_command' and 'server_hint' trigger Redfish pre-fetch.
 * 'power_action' triggers confirmation flow.
 * 'chat' goes directly to Erina without server context.
 */
function classifyIntent(rawText) {
  const text = rawText.trim().toLowerCase();
  const rawWords = text.split(/\s+/);
  const words = rawWords.map(cleanWord).filter(Boolean);
  const firstWord = words[0];

  // ── 1. Exact command match (backward compatible) ──
  const exactCommand = commandAliasMap.get(firstWord);
  if (exactCommand && words.length <= 3) {
    return {
      type: 'exact_command',
      command: exactCommand,
      args: words.slice(1),
    };
  }

  // ── 2. Power action detection (EXACT MATCH ONLY — safety critical) ──
  // NO fuzzy matching for power actions. "masih" must NOT match "mati".
  for (const [action, keywords] of Object.entries(POWER_KEYWORDS)) {
    const hasExactPowerWord = words.some(w => keywords.includes(w));

    if (hasExactPowerWord) {
      // Must also have explicit server context (exact match only)
      const hasServerContext = words.some(w => isServerContextWord(w));

      if (hasServerContext) {
        return {
          type: 'power_action',
          action,
          command: POWER_ACTION_TO_COMMAND[action],
          args: action === 'off' && text.includes('force') ? ['force'] : [],
        };
      }
    }
  }

  // ── 3. STRONG server keyword detection (fuzzy, no context needed) ──
  for (const [topic, keywords] of Object.entries(SERVER_KEYWORDS_STRONG)) {
    for (const word of words) {
      const matched = fuzzyMatch(word, keywords);
      if (matched) {
        return {
          type: 'server_hint',
          topic,
          command: TOPIC_TO_COMMAND[topic],
          matchedKeyword: matched,
          originalWord: word,
        };
      }
    }
  }

  // ── 4. WEAK server keyword detection (exact only, requires server context) ──
  const hasServerContext = words.some(w => isServerContextWord(w));
  if (hasServerContext) {
    for (const [topic, keywords] of Object.entries(WEAK_SERVER_KEYWORDS)) {
      for (const word of words) {
        // Exact match only for weak keywords — NO fuzzy to minimize false positives
        if (keywords.includes(word)) {
          return {
            type: 'server_hint',
            topic,
            command: TOPIC_TO_COMMAND[topic],
            matchedKeyword: word,
            originalWord: word,
          };
        }
      }
    }
  }

  // ── 5. Multi-word pattern detection ──
  // Uses \b and \w* to handle suffixes (servernya, mesinnya) and words in between
  // e.g., "nyalakan kembali servernya" matches via .+?
  const serverWord = '(?:server\\w*|mesin\\w*|komputer\\w*)';
  const multiWordPatterns = [
    { pattern: /gimana\s+.{0,20}(server|mesin)\w*/i, topic: 'status', command: 'status' },
    { pattern: /cek\s+.{0,20}(server|mesin)\w*/i, topic: 'status', command: 'status' },
    { pattern: /power\s*supply/i, topic: 'psu', command: 'psu' },
    { pattern: /catu\s*daya/i, topic: 'psu', command: 'psu' },
    { pattern: /mulai\s*ulang/i, topic: null, command: 'restart', action: 'restart' },
    { pattern: /hard\s*disk/i, topic: 'storage', command: 'disk' },
    { pattern: /event\s*log/i, topic: 'logs', command: 'logs' },
    // Power actions — allow optional words between action and target (max 30 chars)
    { pattern: new RegExp(`matikan\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'off', action: 'off' },
    { pattern: new RegExp(`matiin\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'off', action: 'off' },
    { pattern: new RegExp(`nyalakan\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'on', action: 'on' },
    { pattern: new RegExp(`nyalain\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'on', action: 'on' },
    { pattern: new RegExp(`hidupkan\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'on', action: 'on' },
    { pattern: new RegExp(`hidupin\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'on', action: 'on' },
    { pattern: new RegExp(`restart\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'restart', action: 'restart' },
    { pattern: new RegExp(`shutdown\\s+.{0,30}${serverWord}`, 'i'), topic: null, command: 'off', action: 'off' },
  ];

  for (const { pattern, topic, command, action } of multiWordPatterns) {
    if (pattern.test(text)) {
      if (action) {
        return { type: 'power_action', action, command, args: [] };
      }
      return { type: 'server_hint', topic, command };
    }
  }

  // ── 6. No server-related keywords found → pure chat ──
  return { type: 'chat' };
}

export { classifyIntent, fuzzyMatch, levenshtein };
