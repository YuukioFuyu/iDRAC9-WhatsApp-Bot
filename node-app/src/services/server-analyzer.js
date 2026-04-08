/**
 * Server Data Analyzer — transforms raw Redfish data into status/mood assessments.
 *
 * Implements the analysis rules:
 * 1. Count values from Redfish API
 * 2. Detect uniformity (speed/vendor) and balance (slot/available)
 * 3. Determine status: Optimal → reassuring, Warning → gentle concern, Critical → polite urgency
 * 4. Generate wrap context for Erina's system prompt (maid tone, short sentences, no jargon)
 */

// ── Status & Mood Enums ────────────────────────────

const STATUS = {
  OPTIMAL: 'optimal',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

const MOOD = {
  REASSURING: 'reassuring',
  GENTLE_CONCERN: 'gentle_concern',
  POLITE_URGENCY: 'polite_urgency',
};

const MOOD_INSTRUCTIONS = {
  [MOOD.REASSURING]: [
    'Sampaikan dengan nada lembut dan meyakinkan, tambahkan sedikit pujian untuk kondisi server.',
    'Gunakan emoji positif seperti ✅ ♡ 🌸.',
    'Contoh nada: "Server kita baik-baik saja kok, Goshujin-sama~ ♡"',
  ].join(' '),
  [MOOD.GENTLE_CONCERN]: [
    'Sampaikan dengan perhatian lembut, tanpa panik. Ada hal yang perlu diperhatikan tapi bukan darurat.',
    'Gunakan emoji netral seperti 🤔 💭 ⚡.',
    'Contoh nada: "Hmm, ada yang perlu Erina perhatikan nih, Master..."',
  ].join(' '),
  [MOOD.POLITE_URGENCY]: [
    'Sampaikan dengan urgent namun tetap sopan dan caring. Ini penting dan perlu tindakan segera.',
    'Gunakan emoji peringatan seperti ⚠️ 🚨 ❗.',
    'Contoh nada: "M-Master, maaf mengganggu, tapi ini penting — "',
  ].join(' '),
};

// ── Status → Mood mapping ──────────────────────────

function statusToMood(status) {
  switch (status) {
    case STATUS.OPTIMAL: return MOOD.REASSURING;
    case STATUS.WARNING: return MOOD.GENTLE_CONCERN;
    case STATUS.CRITICAL: return MOOD.POLITE_URGENCY;
    default: return MOOD.REASSURING;
  }
}

// ── Utility Helpers ────────────────────────────────

/**
 * Check if all items in an array have the same value for a given key.
 */
function isUniform(items, key) {
  if (!items || items.length === 0) return { uniform: true, value: null };
  const values = items.map((item) => item[key]).filter(Boolean);
  const unique = [...new Set(values)];
  return {
    uniform: unique.length <= 1,
    value: unique[0] || null,
    uniqueValues: unique,
  };
}

/**
 * Count how many items have a given health status.
 */
function healthCount(items, healthValue = 'OK') {
  if (!items || items.length === 0) return { ok: 0, total: 0, allOk: true };
  const ok = items.filter((item) => item.health === healthValue).length;
  return { ok, total: items.length, allOk: ok === items.length };
}

// ── Analyzers per data type ────────────────────────

/**
 * Analyze system overview / status data.
 */
function analyzeStatus(data) {
  const hints = [];
  let status = STATUS.OPTIMAL;

  const powerState = data.system?.power_state || data.power_state;
  const health = data.system?.health || data.health;
  const healthRollup = data.system?.health_rollup || data.health_rollup;

  // Power state
  if (powerState === 'On') {
    hints.push('Server dalam keadaan menyala');
  } else {
    hints.push(`Server dalam keadaan ${powerState}`);
    status = STATUS.WARNING;
  }

  // Health
  if (health === 'OK' && healthRollup === 'OK') {
    hints.push('Kesehatan sistem: OK');
  } else if (health === 'Warning' || healthRollup === 'Warning') {
    hints.push(`Kesehatan sistem: Warning — ada komponen yang perlu perhatian`);
    status = STATUS.WARNING;
  } else if (health === 'Critical' || healthRollup === 'Critical') {
    hints.push(`Kesehatan sistem: Critical — ada masalah serius`);
    status = STATUS.CRITICAL;
  }

  // System info summary
  const sys = data.system || data;
  if (sys.model) hints.push(`Model: ${sys.model}`);
  if (sys.total_memory_gb) hints.push(`Total RAM: ${sys.total_memory_gb} GB`);
  if (sys.processor_model) hints.push(`CPU: ${sys.processor_model} (×${sys.processor_count || 1})`);

  return {
    type: 'status',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      power_state: powerState,
      health,
      health_rollup: healthRollup,
      model: sys.model,
      total_memory_gb: sys.total_memory_gb,
      processor: sys.processor_model,
      processor_count: sys.processor_count,
    },
    hints,
  };
}

/**
 * Analyze thermal data (temperatures + fans).
 */
function analyzeThermal(data) {
  const temps = data.temperatures || [];
  const fans = data.fans || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  // Temperature analysis
  const tempHealth = healthCount(temps);
  if (tempHealth.allOk) {
    hints.push(`Semua ${tempHealth.total} sensor suhu normal`);
  } else {
    const badTemps = temps.filter((t) => t.health !== 'OK');
    hints.push(`${badTemps.length} sensor suhu bermasalah: ${badTemps.map((t) => t.name).join(', ')}`);
    status = STATUS.WARNING;
  }

  // Check for critical temperatures
  for (const temp of temps) {
    if (temp.reading_celsius && temp.upper_threshold_critical) {
      if (temp.reading_celsius >= temp.upper_threshold_critical) {
        hints.push(`KRITIS: ${temp.name} = ${temp.reading_celsius}°C (batas: ${temp.upper_threshold_critical}°C)`);
        status = STATUS.CRITICAL;
      } else if (temp.reading_celsius >= temp.upper_threshold_critical * 0.85) {
        hints.push(`PERHATIAN: ${temp.name} = ${temp.reading_celsius}°C mendekati batas (${temp.upper_threshold_critical}°C)`);
        if (status !== STATUS.CRITICAL) status = STATUS.WARNING;
      }
    }
  }

  // Avg temp
  const tempReadings = temps.map((t) => t.reading_celsius).filter(Boolean);
  if (tempReadings.length > 0) {
    const avgTemp = (tempReadings.reduce((a, b) => a + b, 0) / tempReadings.length).toFixed(1);
    hints.push(`Suhu rata-rata: ${avgTemp}°C`);
  }

  // Fan analysis
  const fanHealth = healthCount(fans);
  if (fanHealth.allOk) {
    hints.push(`Semua ${fanHealth.total} fan beroperasi normal`);
  } else {
    const badFans = fans.filter((f) => f.health !== 'OK');
    hints.push(`${badFans.length} fan bermasalah: ${badFans.map((f) => f.name).join(', ')}`);
    if (status !== STATUS.CRITICAL) status = STATUS.WARNING;
  }

  // Fan speed uniformity
  const fanSpeeds = fans.map((f) => f.reading_rpm).filter(Boolean);
  if (fanSpeeds.length > 1) {
    const avgSpeed = fanSpeeds.reduce((a, b) => a + b, 0) / fanSpeeds.length;
    const maxDeviation = Math.max(...fanSpeeds.map((s) => Math.abs(s - avgSpeed))) / avgSpeed;
    if (maxDeviation < 0.15) {
      hints.push(`Kecepatan fan seragam (~${Math.round(avgSpeed)} RPM)`);
    } else {
      hints.push(`Kecepatan fan bervariasi (${Math.min(...fanSpeeds)}-${Math.max(...fanSpeeds)} RPM)`);
    }
  }

  return {
    type: 'thermal',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_temps: temps.length,
      total_fans: fans.length,
      temps_ok: tempHealth.ok,
      fans_ok: fanHealth.ok,
      avg_temp: tempReadings.length > 0
        ? (tempReadings.reduce((a, b) => a + b, 0) / tempReadings.length).toFixed(1)
        : null,
    },
    hints,
  };
}

/**
 * Analyze memory/RAM data.
 */
function analyzeMemory(data) {
  const modules = data.modules || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  // Health check
  const memHealth = healthCount(modules);
  if (memHealth.allOk) {
    hints.push(`Semua ${memHealth.total} modul RAM sehat`);
  } else {
    const badMods = modules.filter((m) => m.health !== 'OK');
    hints.push(`${badMods.length} modul bermasalah: ${badMods.map((m) => m.id).join(', ')}`);
    status = STATUS.WARNING;
  }

  // Total capacity
  const totalMB = modules.reduce((sum, m) => sum + (m.capacity_mb || 0), 0);
  const totalGB = (totalMB / 1024).toFixed(1);
  hints.push(`Total kapasitas: ${totalGB} GB dari ${modules.length} modul`);

  // Speed uniformity
  const speedInfo = isUniform(modules, 'speed');
  if (speedInfo.uniform && speedInfo.value) {
    hints.push(`Kecepatan seragam: ${speedInfo.value} MHz`);
  } else if (!speedInfo.uniform) {
    hints.push(`Kecepatan bervariasi: ${speedInfo.uniqueValues.join(', ')} MHz`);
    if (status !== STATUS.CRITICAL) status = STATUS.WARNING;
  }

  // Manufacturer uniformity
  const vendorInfo = isUniform(modules, 'manufacturer');
  if (vendorInfo.uniform && vendorInfo.value) {
    hints.push(`Vendor seragam: ${vendorInfo.value}`);
  } else if (!vendorInfo.uniform) {
    hints.push(`Vendor campuran: ${vendorInfo.uniqueValues.join(', ')}`);
  }

  // Capacity uniformity
  const capInfo = isUniform(modules, 'capacity_mb');
  if (capInfo.uniform && capInfo.value) {
    hints.push(`Kapasitas per modul seragam: ${capInfo.value / 1024} GB`);
  } else if (!capInfo.uniform) {
    hints.push(`Kapasitas bervariasi antar modul`);
  }

  return {
    type: 'memory',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_modules: modules.length,
      total_capacity_gb: totalGB,
      speed_uniform: speedInfo.uniform,
      common_speed: speedInfo.value,
      vendor_uniform: vendorInfo.uniform,
      common_vendor: vendorInfo.value,
      all_healthy: memHealth.allOk,
    },
    hints,
  };
}

/**
 * Analyze storage data.
 */
function analyzeStorage(data) {
  const controllers = data.controllers || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  let totalDrives = 0;
  let healthyDrives = 0;
  let totalCapacityGB = 0;

  for (const ctrl of controllers) {
    const drives = ctrl.drives || [];
    totalDrives += drives.length;

    for (const drive of drives) {
      if (drive.health === 'OK') healthyDrives++;
      totalCapacityGB += drive.capacity_gb || 0;

      if (drive.health !== 'OK') {
        hints.push(`Drive bermasalah: ${drive.name} (${drive.health})`);
        if (drive.health === 'Critical') {
          status = STATUS.CRITICAL;
        } else if (status !== STATUS.CRITICAL) {
          status = STATUS.WARNING;
        }
      }
    }
  }

  if (totalDrives === healthyDrives) {
    hints.push(`Semua ${totalDrives} drive sehat`);
  }
  hints.push(`Total kapasitas: ${totalCapacityGB.toFixed(1)} GB`);
  hints.push(`Controller: ${controllers.length}, Drives: ${totalDrives}`);

  return {
    type: 'storage',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_controllers: controllers.length,
      total_drives: totalDrives,
      healthy_drives: healthyDrives,
      total_capacity_gb: totalCapacityGB.toFixed(1),
    },
    hints,
  };
}

/**
 * Analyze PSU / power details data.
 */
function analyzePower(data) {
  const supplies = data.power_supplies || [];
  const controls = data.power_control || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  // Power consumption
  if (controls.length > 0) {
    const ctrl = controls[0];
    hints.push(`Konsumsi daya: ${ctrl.consumed_watts}W dari kapasitas ${ctrl.capacity_watts}W`);

    const utilization = ctrl.consumed_watts / ctrl.capacity_watts;
    if (utilization > 0.9) {
      hints.push('Konsumsi daya sangat tinggi (>90%)');
      status = STATUS.WARNING;
    } else if (utilization > 0.7) {
      hints.push('Konsumsi daya moderat (~70-90%)');
    } else {
      hints.push('Konsumsi daya normal');
    }
  }

  // PSU health
  const psuHealth = healthCount(supplies);
  if (psuHealth.allOk) {
    hints.push(`Semua ${psuHealth.total} PSU sehat`);
  } else {
    const badPSU = supplies.filter((p) => p.health !== 'OK');
    hints.push(`${badPSU.length} PSU bermasalah: ${badPSU.map((p) => p.name).join(', ')}`);
    status = STATUS.CRITICAL; // PSU failure is always critical
  }

  // PSU redundancy
  if (supplies.length >= 2) {
    hints.push(`Redundansi PSU: ${supplies.length} unit (terlindungi)`);
  } else if (supplies.length === 1) {
    hints.push('Hanya 1 PSU (tidak ada redundansi)');
  }

  return {
    type: 'psu',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_psu: supplies.length,
      all_healthy: psuHealth.allOk,
      consumed_watts: controls[0]?.consumed_watts,
      capacity_watts: controls[0]?.capacity_watts,
    },
    hints,
  };
}

/**
 * Analyze network data.
 */
function analyzeNetwork(data) {
  const interfaces = data.interfaces || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  const nicHealth = healthCount(interfaces);
  if (nicHealth.allOk) {
    hints.push(`Semua ${nicHealth.total} interface aktif dan sehat`);
  } else {
    const badNICs = interfaces.filter((n) => n.health !== 'OK');
    hints.push(`${badNICs.length} interface bermasalah`);
    status = STATUS.WARNING;
  }

  // Speed info
  const speeds = interfaces.map((n) => n.speed_mbps).filter(Boolean);
  if (speeds.length > 0) {
    hints.push(`Kecepatan: ${[...new Set(speeds)].join(', ')} Mbps`);
  }

  // IP addresses
  const ips = interfaces.flatMap((n) => n.ipv4 || []).filter(Boolean);
  if (ips.length > 0) {
    hints.push(`IP aktif: ${ips.join(', ')}`);
  }

  return {
    type: 'network',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_interfaces: interfaces.length,
      all_healthy: nicHealth.allOk,
      active_ips: ips,
    },
    hints,
  };
}

/**
 * Analyze log entries.
 */
function analyzeLogs(data) {
  const entries = data.entries || [];
  const hints = [];
  let status = STATUS.OPTIMAL;

  const criticals = entries.filter((e) => e.severity === 'Critical');
  const warnings = entries.filter((e) => e.severity === 'Warning');

  if (criticals.length > 0) {
    hints.push(`${criticals.length} event critical ditemukan`);
    hints.push(`Critical terbaru: ${criticals[0]?.message || 'N/A'}`);
    status = STATUS.CRITICAL;
  }

  if (warnings.length > 0) {
    hints.push(`${warnings.length} event warning ditemukan`);
    if (status !== STATUS.CRITICAL) status = STATUS.WARNING;
  }

  const normals = entries.length - criticals.length - warnings.length;
  if (normals > 0) {
    hints.push(`${normals} event informational`);
  }

  if (criticals.length === 0 && warnings.length === 0) {
    hints.push(`Semua ${entries.length} log entry normal`);
  }

  return {
    type: 'logs',
    status,
    mood: statusToMood(status),
    moodInstruction: MOOD_INSTRUCTIONS[statusToMood(status)],
    summary: {
      total_entries: entries.length,
      critical_count: criticals.length,
      warning_count: warnings.length,
    },
    hints,
  };
}

// ── Main Analyzer Entry Point ──────────────────────

/**
 * Analyze Redfish data based on its type and return a status assessment.
 *
 * @param {object} data - Raw data from Redfish API
 * @param {string} type - Data type: status, temp, memory, disk, psu, network, logs
 * @returns {object} Analysis result with status, mood, summary, hints
 */
function analyzeServerData(data, type) {
  if (!data) {
    return {
      type,
      status: STATUS.OPTIMAL,
      mood: MOOD.REASSURING,
      moodInstruction: MOOD_INSTRUCTIONS[MOOD.REASSURING],
      summary: {},
      hints: ['Data tidak tersedia'],
    };
  }

  switch (type) {
    case 'status':
      return analyzeStatus(data);
    case 'temp':
    case 'thermal':
      return analyzeThermal(data);
    case 'memory':
      return analyzeMemory(data);
    case 'disk':
    case 'storage':
      return analyzeStorage(data);
    case 'psu':
      return analyzePower(data);
    case 'network':
      return analyzeNetwork(data);
    case 'logs':
      return analyzeLogs(data);
    default:
      return {
        type,
        status: STATUS.OPTIMAL,
        mood: MOOD.REASSURING,
        moodInstruction: MOOD_INSTRUCTIONS[MOOD.REASSURING],
        summary: data,
        hints: ['Data tersedia'],
      };
  }
}

export { analyzeServerData, STATUS, MOOD, MOOD_INSTRUCTIONS };
