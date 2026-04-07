/**
 * Command Parser — maps WhatsApp text to iDRAC actions.
 *
 * Prefix behavior:
 * - If WA_COMMAND_PREFIX is set (e.g., "!"): only messages starting with "!" are treated as commands
 * - If WA_COMMAND_PREFIX is empty: ALL messages are treated as commands (future AI integration ready)
 */

import { redfishClient } from './redfish-client.js';

import config from '../config.js';
import logger from './logger.js';

// ── Command Registry ───────────────────────────────

const COMMANDS = {
  status: {
    description: 'Lihat status server secara keseluruhan',
    aliases: ['st', 'info'],
    handler: handleStatus,
  },
  power: {
    description: 'Lihat power state server',
    aliases: ['pwr'],
    handler: handlePower,
  },
  psu: {
    description: 'Lihat informasi Power Supply (PSU)',
    aliases: ['power-supply'],
    handler: handlePsu,
  },
  on: {
    description: 'Nyalakan server',
    aliases: ['poweron', 'start'],
    handler: handlePowerOn,
    confirm: true,
  },
  off: {
    description: 'Matikan server (graceful)',
    aliases: ['poweroff', 'shutdown', 'stop'],
    handler: handlePowerOff,
    confirm: true,
  },
  restart: {
    description: 'Restart server',
    aliases: ['reboot', 'reset'],
    handler: handleRestart,
    confirm: true,
  },
  temp: {
    description: 'Lihat suhu & kecepatan fan',
    aliases: ['thermal', 'suhu', 'fan'],
    handler: handleThermal,
  },
  disk: {
    description: 'Lihat informasi storage/disk',
    aliases: ['storage', 'raid'],
    handler: handleStorage,
  },
  logs: {
    description: 'Lihat event log terbaru',
    aliases: ['log', 'sel', 'events'],
    handler: handleLogs,
  },
  network: {
    description: 'Lihat informasi network interfaces (NIC)',
    aliases: ['net', 'nic', 'ip'],
    handler: handleNetwork,
  },
  memory: {
    description: 'Lihat informasi RAM / Memory',
    aliases: ['ram', 'mem'],
    handler: handleMemory,
  },
  idrac_reset: {
    description: 'Restart iDRAC controller (Safe)',
    aliases: ['bmc-reset', 'idrac-restart'],
    handler: handleIdracReset,
    confirm: true,
  },
  help: {
    description: 'Tampilkan daftar perintah',
    aliases: ['h', 'bantuan', 'menu', '?'],
    handler: handleHelp,
  },
};

// ── Build alias lookup map ─────────────────────────
const aliasMap = new Map();
for (const [name, cmd] of Object.entries(COMMANDS)) {
  aliasMap.set(name, name);
  for (const alias of cmd.aliases) {
    aliasMap.set(alias, name);
  }
}

// ── Parse & Execute ────────────────────────────────

/**
 * Parse a WhatsApp message and execute the corresponding command.
 * @param {string} rawText - The message text
 * @returns {{ command: string, response: string }} The parsed command and response text
 */
async function parseAndExecute(rawText) {
  const prefix = config.whatsapp.commandPrefix;
  let text = rawText.trim();

  // If prefix is set, check and strip it
  if (prefix && text.startsWith(prefix)) {
    text = text.slice(prefix.length).trim();
  }

  // Split into command and args
  const parts = text.toLowerCase().split(/\s+/);
  const cmdInput = parts[0];
  const args = parts.slice(1);

  // Look up command
  const cmdName = aliasMap.get(cmdInput);
  if (!cmdName) {
    return {
      command: cmdInput || 'unknown',
      response: `❌ Perintah tidak dikenali.\n\nKetik *${prefix}help* untuk melihat daftar perintah.`,
    };
  }

  const cmd = COMMANDS[cmdName];

  try {
    logger.info({ command: cmdName, args }, 'Executing WhatsApp command');
    const response = await cmd.handler(args);
    return { command: cmdName, response };
  } catch (err) {
    logger.error({ command: cmdName, err: err.message }, 'Command execution failed');
    return {
      command: cmdName,
      response: `❌ *Error*: ${err.message}\n\niDRAC mungkin tidak dapat dijangkau. Coba lagi nanti.`,
    };
  }
}

// ── Command Handlers ───────────────────────────────

async function handleStatus() {
  const data = await redfishClient.getFullStatus();
  const sys = data.system;
  const therm = data.thermal;

  // Find max CPU temp
  const cpuTemps = therm.temperatures
    ?.filter((t) => t.name?.toLowerCase().includes('cpu'))
    ?.map((t) => `${t.name}: ${t.reading_celsius}°C`) || [];

  const powerIcon = sys.power_state === 'On' ? '✅' : '🔴';
  const healthIcon = sys.health === 'OK' ? '✅' : '⚠️';

  return [
    `🖥️ *Server Status*`,
    ``,
    `📋 *System Info*`,
    `├ Model: ${sys.model}`,
    `├ Service Tag: ${sys.service_tag}`,
    `├ BIOS: ${sys.bios_version}`,
    `├ CPU: ${sys.processor_model} (×${sys.processor_count})`,
    `└ RAM: ${sys.total_memory_gb} GB`,
    ``,
    `⚡ *Power*: ${powerIcon} ${sys.power_state}`,
    `🏥 *Health*: ${healthIcon} ${sys.health}`,
    ``,
    `🌡️ *Temperatures*`,
    ...cpuTemps.map((t) => `├ ${t}`),
    ``,
    `🌀 *Fans*: ${therm.fans?.length || 0} active`,
  ].join('\n');
}

async function handlePower() {
  const data = await redfishClient.getPowerState();
  const state = data.data;
  const icon = state.power_state === 'On' ? '✅' : '🔴';

  return [
    `⚡ *Power State*`,
    ``,
    `Status: ${icon} *${state.power_state}*`,
    `Health: ${state.health}`,
  ].join('\n');
}

async function handlePsu() {
  const data = await redfishClient.getPowerDetails();
  const info = data.data;

  const lines = [`🔌 *Power Supply Details*`, ``];

  if (info.power_control && info.power_control.length > 0) {
    const ctrl = info.power_control[0];
    lines.push(`*Overall Consumption*`);
    lines.push(`├ Consumed: ${ctrl.consumed_watts} Watts`);
    lines.push(`├ Capacity: ${ctrl.capacity_watts} Watts`);
    lines.push(`├ Min: ${ctrl.min_watts}W | Max: ${ctrl.max_watts}W`);
    lines.push(`└ Average: ${ctrl.avg_watts} Watts`);
    lines.push(``);
  }

  if (info.power_supplies && info.power_supplies.length > 0) {
    lines.push(`*PSU Modules*`);
    for (const psu of info.power_supplies) {
      const icon = psu.health === 'OK' ? '✅' : '⚠️';
      lines.push(`*${psu.name}*`);
      lines.push(`├ Status: ${icon} ${psu.health}`);
      lines.push(`├ Model: ${psu.model}`);
      lines.push(`├ Capacity: ${psu.capacity_watts} Watts`);
      lines.push(`├ Output: ${psu.output_watts} Watts`);
      lines.push(`└ Input Voltage: ${psu.input_voltage}V`);
      lines.push(``);
    }
  } else {
    lines.push(`_Tidak ada informasi modul PSU._`);
  }

  return lines.join('\n');
}

async function handlePowerOn() {
  await redfishClient.powerOn();
  return `✅ *Power ON* command sent!\n\nServer sedang dinyalakan...`;
}

async function handlePowerOff(args) {
  const force = args.includes('force') || args.includes('-f');
  await redfishClient.powerOff(force);
  const mode = force ? 'Force Off' : 'Graceful Shutdown';
  return `🔴 *${mode}* command sent!\n\nServer sedang dimatikan...`;
}

async function handleRestart(args) {
  const force = args.includes('force') || args.includes('-f');
  await redfishClient.powerReset(force);
  const mode = force ? 'Force Restart' : 'Graceful Restart';
  return `🔄 *${mode}* command sent!\n\nServer sedang di-restart...`;
}

async function handleThermal() {
  const data = await redfishClient.getThermal();
  const therm = data.data;

  const tempLines = (therm.temperatures || []).map((t) => {
    const icon = t.health === 'OK' ? '✅' : '⚠️';
    return `├ ${icon} ${t.name}: ${t.reading_celsius}°C`;
  });

  const fanLines = (therm.fans || []).map((f) => {
    const icon = f.health === 'OK' ? '✅' : '⚠️';
    return `├ ${icon} ${f.name}: ${f.reading_rpm} RPM`;
  });

  return [
    `🌡️ *Thermal Report*`,
    ``,
    `*Temperatures*`,
    ...tempLines,
    ``,
    `🌀 *Fan Speeds*`,
    ...fanLines,
  ].join('\n');
}

async function handleStorage() {
  const data = await redfishClient.getStorage();
  const storage = data.data;

  const lines = [];
  for (const ctrl of storage.controllers || []) {
    lines.push(`📦 *${ctrl.name}* (${ctrl.drives_count} drives)`);
    for (const drive of ctrl.drives || []) {
      const icon = drive.health === 'OK' ? '✅' : '⚠️';
      lines.push(
        `├ ${icon} ${drive.name}: ${drive.capacity_gb}GB ${drive.media_type} (${drive.protocol})`
      );
    }
    lines.push(``);
  }

  return [`💾 *Storage Report*`, ``, ...lines].join('\n');
}

async function handleLogs(args) {
  const count = parseInt(args[0]) || 5;
  const data = await redfishClient.getLatestLogs(Math.min(count, 20));
  const logs = data.data;

  const logLines = (logs.entries || []).map((entry) => {
    const icon = entry.severity === 'Critical' ? '🔴'
      : entry.severity === 'Warning' ? '⚠️' : '📋';
    return `${icon} [${entry.created}]\n   ${entry.message}`;
  });

  return [
    `📋 *Event Log* (terakhir ${logs.entries?.length || 0})`,
    ``,
    ...logLines,
  ].join('\n');
}

async function handleNetwork() {
  const data = await redfishClient.getNetwork();
  const net = data.data;

  const lines = [`🌐 *Network Interfaces* (${net.total_interfaces} active)`, ``];
  for (const nic of net.interfaces || []) {
    const icon = nic.health === 'OK' ? '✅' : '⚠️';
    lines.push(`*${nic.name}*`);
    lines.push(`├ Status: ${icon} ${nic.health}`);
    lines.push(`├ MAC: ${nic.mac}`);
    lines.push(`├ Speed: ${nic.speed_mbps} Mbps`);
    if (nic.ipv4 && nic.ipv4.length > 0) {
      lines.push(`└ IPv4: ${nic.ipv4.join(', ')}`);
    } else {
      lines.push(`└ IPv4: Disconnected`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

async function handleMemory() {
  const data = await redfishClient.getMemory();
  const mem = data.data;

  let totalSizeMB = 0;
  const lines = [];
  for (const mod of mem.modules || []) {
    totalSizeMB += mod.capacity_mb || 0;
    const icon = mod.health === 'OK' ? '✅' : '⚠️';
    lines.push(`├ ${icon} ${mod.id}: ${mod.capacity_mb}MB ${mod.type} (${mod.speed}MHz)`);
  }

  const totalGB = (totalSizeMB / 1024).toFixed(1);
  return [
    `🧠 *Memory Report*`,
    ``,
    `*Total Installed*: ${totalGB} GB`,
    `*Active Modules*: ${mem.total_modules}`,
    ``,
    `*DIMM Details*`,
    ...lines,
  ].join('\n');
}

async function handleIdracReset() {
  await redfishClient.resetIdrac();
  return `🔄 *iDRAC Reset* command sent!\n\nController BMC sedang di-restart. Server OS tetap berjalan normal. Proses ini memakan waktu sekitar 2-3 menit.`;
}

async function handleHelp() {
  const prefix = config.whatsapp.commandPrefix;
  const lines = [`📖 *Daftar Perintah*`, ``];

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(', ')})` : '';
    lines.push(`*${prefix}${name}*${aliases}`);
    lines.push(`└ ${cmd.description}`);
    lines.push(``);
  }

  if (!prefix) {
    lines.push(`ℹ️ _Tidak ada prefix. Ketik langsung nama perintah._`);
  }

  return lines.join('\n');
}

export { parseAndExecute, COMMANDS };
