/**
 * Dashboard client-side JavaScript.
 * Auto-refreshes iDRAC data every 30 seconds.
 *
 * FIX: Emojis are rendered in separate .metric-emoji spans
 * so the gradient text effect on .metric-text doesn't colorize them.
 */

// ── State ──────────────────────────────────────────
let refreshInterval = null;
const REFRESH_MS = 30_000;

// ── Initialize ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchAllData();
  refreshInterval = setInterval(fetchAllData, REFRESH_MS);
});

// ── Fetch all dashboard data ───────────────────────
async function fetchAllData() {
  await Promise.allSettled([
    fetchStatus(),
    fetchWhatsAppStatus(),
    fetchNetwork(),
    fetchMemory(),
    fetchProcessors(),
    fetchPsu(),
    fetchUpcomingSchedules()
  ]);
}

// ── Fetch iDRAC status ─────────────────────────────
async function fetchStatus() {
  try {
    const resp = await fetch('/api/status');
    const json = await resp.json();

    if (!json.success) throw new Error(json.message);

    const sys = json.data.system;
    const therm = json.data.thermal;

    // Update iDRAC status card
    setMetric('idrac-status', '', 'Connected');
    updateBadge('idrac-badge', 'badge-success', 'Connected');
    updateElement('idrac-dot', null, 'status-dot status-dot-success');

    // Update power state card — emoji separated from gradient text
    const powerIcon = sys.power_state === 'On' ? '✅' : '🔴';
    setMetric('power-state', powerIcon, sys.power_state);
    updateElement('health-state', `Health: ${sys.health}`);

    // Update system info
    const infoHtml = `
      <div class="flex justify-between py-2 border-b border-white/5">
        <span class="text-sm text-surface-500">Model</span>
        <span class="text-sm font-medium text-surface-200">${esc(sys.model)}</span>
      </div>
      <div class="flex justify-between py-2 border-b border-white/5">
        <span class="text-sm text-surface-500">Service Tag</span>
        <span class="text-sm font-mono text-accent">${esc(sys.service_tag)}</span>
      </div>
      <div class="flex justify-between py-2 border-b border-white/5">
        <span class="text-sm text-surface-500">BIOS</span>
        <span class="text-sm font-medium text-surface-200">${esc(sys.bios_version)}</span>
      </div>
      <div class="flex justify-between py-2 border-b border-white/5">
        <span class="text-sm text-surface-500">CPU</span>
        <span class="text-sm font-medium text-surface-200">${esc(sys.processor_model)} (×${sys.processor_count})</span>
      </div>
      <div class="flex justify-between py-2 border-b border-white/5">
        <span class="text-sm text-surface-500">Memory</span>
        <span class="text-sm font-medium text-surface-200">${sys.total_memory_gb} GB</span>
      </div>
      <div class="flex justify-between py-2">
        <span class="text-sm text-surface-500">Hostname</span>
        <span class="text-sm font-medium text-surface-200">${esc(sys.hostname) || '—'}</span>
      </div>
    `;
    document.getElementById('system-info').innerHTML = infoHtml;

    // Update temperature sensors
    if (therm.temperatures && therm.temperatures.length > 0) {
      const tempHtml = therm.temperatures.map((t) => {
        const pct = Math.min(100, (t.reading_celsius / (t.upper_threshold_critical || 100)) * 100);
        const color = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-green-500';
        return `
          <div class="flex items-center gap-3">
            <span class="text-xs text-surface-500 w-28 truncate" title="${esc(t.name)}">${esc(t.name)}</span>
            <div class="flex-1 h-2 rounded-full bg-surface-800 overflow-hidden">
              <div class="h-full rounded-full ${color} transition-all duration-500" style="width: ${pct}%"></div>
            </div>
            <span class="text-xs font-mono text-surface-300 w-12 text-right">${t.reading_celsius}°C</span>
          </div>
        `;
      }).join('');
      document.getElementById('temp-sensors').innerHTML = tempHtml;
    }

    // Update fan speeds
    if (therm.fans && therm.fans.length > 0) {
      const fanHtml = therm.fans.map((f) => {
        const icon = f.health === 'OK' ? '✅' : '⚠️';
        return `
          <div class="p-3 rounded-lg bg-surface-800/50 border border-white/5 text-center">
            <p class="text-xs text-surface-500 truncate" title="${esc(f.name)}">${esc(f.name)}</p>
            <p class="text-lg font-semibold text-surface-200 mt-1">${f.reading_rpm}</p>
            <p class="text-xs text-surface-600">${esc(f.units)} ${icon}</p>
          </div>
        `;
      }).join('');
      document.getElementById('fan-speeds').innerHTML = fanHtml;
    }

  } catch (err) {
    console.error('Status fetch error:', err);
    setMetric('idrac-status', '', 'Offline');
    updateBadge('idrac-badge', 'badge-danger', 'Offline');
    updateElement('idrac-dot', null, 'status-dot status-dot-danger');
  }
}

// ── Fetch WhatsApp Status ──────────────────────────
async function fetchWhatsAppStatus() {
  try {
    const resp = await fetch('/whatsapp/status');
    const json = await resp.json();

    if (!json.success) return;

    const wa = json.data;

    if (wa.status === 'connected') {
      setMetric('wa-status', '✅', 'Connected');
      updateElement('wa-number', `+${wa.linkedNumber}`);
    } else {
      setMetric('wa-status', '🔴', wa.status);
      updateElement('wa-number', '—');
    }
  } catch {
    setMetric('wa-status', '❌', 'Error');
  }
}

// ── Fetch Network Interfaces ───────────────────────
async function fetchNetwork() {
  try {
    const resp = await fetch('/api/network');
    const json = await resp.json();
    if (!json.success) return;

    const net = json.data;
    if (net.interfaces && net.interfaces.length > 0) {
      const html = net.interfaces.map(n => `
        <div class="flex flex-col py-2 border-b border-white/5 last:border-0">
          <div class="flex justify-between items-center">
            <span class="text-sm font-medium text-surface-200 truncate w-3/4" title="${esc(n.name)}">${esc(n.name)}</span>
            <span class="text-xs ${n.health === 'OK' ? 'text-success' : 'text-warning'}">${n.health}</span>
          </div>
          <div class="flex justify-between text-xs text-surface-500 mt-1">
            <span>MAC: <span class="font-mono">${esc(n.mac)}</span></span>
            <span>${n.speed_mbps} Mbps</span>
          </div>
          <div class="text-xs text-surface-400 mt-1">IPv4: ${n.ipv4?.length ? n.ipv4.join(', ') : 'Disconnected'}</div>
        </div>
      `).join('');
      document.getElementById('network-info').innerHTML = html;
    } else {
      document.getElementById('network-info').innerHTML = '<p class="text-sm text-surface-500">No network interfaces found.</p>';
    }
  } catch (err) {
    console.error('Fetch network error', err);
  }
}

// ── Fetch Memory ───────────────────────────────────
async function fetchMemory() {
  try {
    const resp = await fetch('/api/memory');
    const json = await resp.json();
    if (!json.success) return;

    const mem = json.data;
    if (mem.modules && mem.modules.length > 0) {
      const html = mem.modules.map(m => `
        <div class="flex justify-between items-center py-2 border-b border-white/5 last:border-0">
          <div class="flex flex-col">
            <span class="text-sm font-medium text-surface-200">${esc(m.id)} <span class="text-xs text-surface-500">(${esc(m.type)})</span></span>
            <span class="text-xs text-surface-500">${esc(m.manufacturer)}</span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-sm font-mono text-accent">${m.capacity_mb} MB</span>
            <span class="text-xs text-surface-400">${m.speed} MHz</span>
          </div>
        </div>
      `).join('');
      document.getElementById('memory-info').innerHTML = html;
    } else {
      document.getElementById('memory-info').innerHTML = '<p class="text-sm text-surface-500">No memory modules found.</p>';
    }
  } catch (err) {
    console.error('Fetch memory error', err);
  }
}

// ── Fetch Processors ───────────────────────────────
async function fetchProcessors() {
  try {
    const resp = await fetch('/api/processors');
    const json = await resp.json();
    if (!json.success) return;

    const cpu = json.data;
    if (cpu.cpus && cpu.cpus.length > 0) {
      const html = cpu.cpus.map(c => `
        <div class="flex flex-col py-2 border-b border-white/5 last:border-0">
          <div class="flex justify-between items-start">
            <span class="text-sm font-medium text-surface-200 max-w-[80%]">${esc(c.model)}</span>
            <span class="text-xs ${c.health === 'OK' ? 'text-success' : 'text-warning'}">${c.health}</span>
          </div>
          <div class="flex justify-between text-xs text-surface-400 mt-2">
            <span>${c.cores} Cores / ${c.threads} Threads</span>
            <span class="font-mono text-accent">${c.speed_mhz} MHz max</span>
          </div>
        </div>
      `).join('');
      document.getElementById('processor-info').innerHTML = html;
    } else {
      document.getElementById('processor-info').innerHTML = '<p class="text-sm text-surface-500">No processors found.</p>';
    }
  } catch (err) {
    console.error('Fetch processors error', err);
  }
}

// ── Fetch PSU ──────────────────────────────────────
async function fetchPsu() {
  try {
    const resp = await fetch('/api/power/details');
    const json = await resp.json();
    if (!json.success) return;

    const info = json.data;
    let html = '';

    if (info.power_control && info.power_control.length > 0) {
      const ctrl = info.power_control[0];
      html += `
        <div class="mb-4">
          <p class="text-xs font-semibold text-surface-400 mb-2 uppercase tracking-wider">Consumption</p>
          <div class="flex justify-between items-center mb-1">
            <span class="text-sm font-medium text-surface-200">${ctrl.consumed_watts} Watts</span>
            <span class="text-xs text-surface-500">Avg: ${ctrl.avg_watts}W</span>
          </div>
          <div class="w-full bg-surface-800 rounded-full h-1.5 mb-2">
            <div class="bg-orange-500 h-1.5 rounded-full" style="width: ${Math.min(100, (ctrl.consumed_watts / (ctrl.capacity_watts || 1000)) * 100)}%"></div>
          </div>
          <p class="text-[10px] text-surface-500 text-right">Max Capacity: ${ctrl.capacity_watts}W</p>
        </div>
      `;
    }

    if (info.power_supplies && info.power_supplies.length > 0) {
      html += `<p class="text-xs font-semibold text-surface-400 mb-2 uppercase tracking-wider">Modules</p>`;
      html += info.power_supplies.map(psu => `
        <div class="flex justify-between items-start py-2 border-t border-white/5">
          <div class="flex flex-col">
            <span class="text-sm font-medium text-surface-200">${esc(psu.name)}</span>
            <span class="text-[10px] text-surface-500 font-mono">${esc(psu.model)}</span>
            <span class="text-xs mt-1 ${psu.health === 'OK' ? 'text-success' : 'text-warning'}">${psu.health}</span>
          </div>
          <div class="flex flex-col items-end">
            <span class="text-sm text-surface-300">${psu.output_watts} W / ${psu.capacity_watts} W</span>
            <span class="text-xs text-surface-500 mt-1">${psu.input_voltage}V IN</span>
          </div>
        </div>
      `).join('');
    } else {
      html += '<p class="text-sm text-surface-500">No PSU data found.</p>';
    }

    document.getElementById('psu-info').innerHTML = html || '<p class="text-sm text-surface-500">No data available.</p>';
  } catch (err) {
    console.error('Fetch PSU error', err);
  }
}

// ── Fetch Upcoming Schedules ───────────────────────
async function fetchUpcomingSchedules() {
  try {
    const resp = await fetch('/api/schedules/upcoming');
    const json = await resp.json();
    const container = document.getElementById('upcoming-schedules');
    if (!container) return;

    if (!json.success || !json.data || json.data.length === 0) {
      container.innerHTML = `
        <div class="flex items-center gap-3 py-2">
          <span class="text-sm text-surface-500">No active schedules</span>
          <a href="/schedule" class="text-xs text-accent hover:text-accent-hover transition-colors">+ Add</a>
        </div>
      `;
      return;
    }

    const html = json.data.map(s => {
      const typeBadge = s.type === 'power'
        ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 font-semibold">⚡ Power</span>'
        : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 font-semibold">🔧 Redfish</span>';

      const actionText = s.type === 'power'
        ? (s.action === 'on' ? 'Power On' : 'Power Off')
        : (s.action?.length > 25 ? s.action.substring(0, 25) + '...' : s.action);

      const dateText = s.is_everyday || s.is_everyday === 1
        ? 'Everyday'
        : (s.schedule_date || '—');

      return `
        <div class="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
          <div class="flex items-center gap-3 min-w-0">
            ${typeBadge}
            <div class="min-w-0">
              <span class="text-sm text-surface-200 font-medium truncate block">${esc(s.name)}</span>
              <span class="text-[10px] text-surface-500">${esc(actionText)}</span>
            </div>
          </div>
          <div class="flex flex-col items-end shrink-0">
            <span class="text-xs font-mono text-accent">${s.schedule_time}</span>
            <span class="text-[10px] text-surface-500">${dateText}</span>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  } catch (err) {
    console.error('Fetch upcoming schedules error:', err);
    const container = document.getElementById('upcoming-schedules');
    if (container) {
      container.innerHTML = '<p class="text-sm text-surface-600">Failed to load schedules</p>';
    }
  }
}

// ── Reset iDRAC ────────────────────────────────────
async function resetIdrac() {
  if (!confirm('⚠️ Restart iDRAC (BMC)? Server utama akan tetap hidup, namun kontrol iDRAC akan offline selama 2-3 menit.')) return;
  try {
    const resp = await fetch('/api/actions/idrac-reset', { method: 'POST' });
    const json = await resp.json();
    if (json.success) {
      showToast('✅ iDRAC Restart command sent!');
    } else {
      showToast(`❌ ${json.message}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  }
}

// ── Power Actions ──────────────────────────────────
async function powerAction(action) {
  const confirmMsg = {
    on: 'Nyalakan server?',
    off: 'Matikan server (Graceful Shutdown)?',
    reset: 'Restart server?',
  };

  if (!confirm(`⚡ ${confirmMsg[action]}`)) return;

  try {
    const resp = await fetch(`/api/power/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
    const json = await resp.json();

    if (json.success) {
      showToast(`✅ ${action.toUpperCase()} command sent!`);
      // Refresh status after 3 seconds
      setTimeout(fetchStatus, 3000);
    } else {
      showToast(`❌ ${json.message}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  }
}

// ── Helpers ────────────────────────────────────────

/**
 * Set metric value with separated emoji + text to avoid gradient colorization.
 * @param {string} id - Element ID
 * @param {string} emoji - Emoji character (or empty string)
 * @param {string} text - Text value
 */
function setMetric(id, emoji, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (emoji) {
    el.innerHTML = `<span class="metric-emoji">${emoji}</span><span class="metric-text">${esc(text)}</span>`;
  } else {
    el.innerHTML = `<span class="metric-text">${esc(text)}</span>`;
  }
}

function updateElement(id, text, className) {
  const el = document.getElementById(id);
  if (!el) return;
  if (text !== null && text !== undefined) el.textContent = text;
  if (className) el.className = className;
}

function updateBadge(id, badgeClass, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `badge ${badgeClass}`;
  const textEl = document.getElementById(`${id.replace('badge', 'badge-text')}`);
  if (textEl) textEl.textContent = text;
}

/** Safe HTML escape */
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const bgColor = type === 'error' ? 'bg-red-500/90' : 'bg-green-500/90';
  toast.className = `fixed bottom-6 right-6 ${bgColor} text-white px-5 py-3 rounded-xl text-sm font-medium shadow-2xl z-50 animate-slide-up backdrop-blur-sm`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
