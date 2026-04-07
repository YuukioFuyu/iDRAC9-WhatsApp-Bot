/**
 * WhatsApp page client-side JavaScript.
 * Handles QR SSE stream, pairing code, and chat history.
 *
 * SSE FIX: 'reconnecting' event keeps the QR UI open instead of
 * switching back to disconnected state. 'disconnected' only fires
 * on explicit logout or max retries.
 */

// ── State ──────────────────────────────────────────
let eventSource = null;

// ── Initialize ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  refreshChatLogs();
  // Auto-refresh chat logs every 10s
  setInterval(refreshChatLogs, 10_000);
});

// ── Check initial status ───────────────────────────
async function checkStatus() {
  try {
    const resp = await fetch('/whatsapp/status');
    const json = await resp.json();

    if (!json.success) return;

    updateUIState(json.data.status, json.data);

    // If already connected, done
    if (json.data.status === 'connected') return;

    // If connecting/waiting_scan, auto-start SSE to catch QR
    if (json.data.status === 'waiting_scan' || json.data.status === 'connecting') {
      startQRStream();
    }
  } catch {
    updateUIState('disconnected');
  }
}

// ── UI State Management ────────────────────────────
function updateUIState(status, data = {}) {
  const states = ['disconnected', 'waiting', 'connected'];
  states.forEach((s) => {
    const el = document.getElementById(`state-${s}`);
    if (el) el.classList.add('hidden');
  });

  const badge = document.getElementById('wa-badge');
  const dot = document.getElementById('wa-status-dot');
  const badgeText = document.getElementById('wa-badge-text');

  switch (status) {
    case 'connected':
      show('state-connected');
      if (data.linkedNumber || data.number) {
        document.getElementById('connected-number').textContent = `+${data.linkedNumber || data.number}`;
        document.getElementById('connected-name').textContent = data.linkedName || data.name || '';
      }
      badge.className = 'badge badge-success';
      dot.className = 'status-dot status-dot-success';
      badgeText.textContent = 'Connected';

      // Re-enable connect button for future use
      resetConnectButton();
      break;

    case 'waiting_scan':
    case 'connecting':
      show('state-waiting');
      badge.className = 'badge badge-warning';
      dot.className = 'status-dot status-dot-warning';
      badgeText.textContent = status === 'connecting' ? 'Connecting...' : 'Waiting for Scan';
      break;

    default:
      show('state-disconnected');
      badge.className = 'badge badge-danger';
      dot.className = 'status-dot status-dot-danger';
      badgeText.textContent = 'Disconnected';
      resetConnectButton();
      break;
  }
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function resetConnectButton() {
  const btn = document.getElementById('btn-connect');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '📱 Connect via QR Code';
  }
}

// ── Connect WhatsApp (QR mode) ─────────────────────
async function connectWhatsApp() {
  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = '⏳ Connecting...';

  try {
    // Start SSE FIRST (before connect), so we don't miss the QR
    startQRStream();

    // Then initiate connection
    const resp = await fetch('/whatsapp/connect', { method: 'POST' });
    const json = await resp.json();

    if (!json.success) {
      showToast(`❌ ${json.message}`, 'error');
      closeQRStream();
      resetConnectButton();
      return;
    }

    // Switch to waiting state
    updateUIState('waiting_scan');
  } catch (err) {
    showToast(`❌ Connection error: ${err.message}`, 'error');
    closeQRStream();
    resetConnectButton();
  }
}

// ── SSE: QR Code Stream ────────────────────────────
function startQRStream() {
  // Don't create multiple SSE connections
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return;
  }

  eventSource = new EventSource('/whatsapp/qr');

  // New QR code received
  eventSource.addEventListener('qr', (event) => {
    const data = JSON.parse(event.data);
    const qrDisplay = document.getElementById('qr-display');
    if (qrDisplay && data.qr) {
      qrDisplay.innerHTML = `<img src="${data.qr}" alt="QR Code" class="w-[250px] h-[250px]">`;
    }
    updateUIState('waiting_scan');
  });

  // Successfully connected
  eventSource.addEventListener('connected', (event) => {
    const data = JSON.parse(event.data);
    updateUIState('connected', data);
    closeQRStream();
    showToast('✅ WhatsApp connected!');
    refreshChatLogs();
  });

  // KEY FIX: 'reconnecting' keeps the QR UI open
  // Shows a "Reconnecting..." overlay but does NOT close the SSE stream
  eventSource.addEventListener('reconnecting', (event) => {
    const data = JSON.parse(event.data);

    // Keep showing the QR waiting state (don't switch to disconnected!)
    updateUIState('waiting_scan');

    // Update timer text
    const timerEl = document.getElementById('qr-timer');
    if (timerEl) {
      timerEl.textContent = `Reconnecting... (attempt ${data.retryCount})`;
    }

    // Show shimmer in QR display while waiting for new QR
    const qrDisplay = document.getElementById('qr-display');
    if (qrDisplay) {
      qrDisplay.innerHTML = `<div class="w-[250px] h-[250px] shimmer flex items-center justify-center"><span class="text-sm text-surface-500">Generating QR...</span></div>`;
    }
  });

  // 'disconnected' only fires on explicit logout or max retries
  // THIS is when we actually close the SSE and switch UI
  eventSource.addEventListener('disconnected', (event) => {
    const data = JSON.parse(event.data);
    const reason = data.reason || 'unknown';

    if (reason === 'max_retries') {
      showToast('❌ Max reconnect attempts exceeded', 'error');
    } else if (reason === 'logged_out') {
      showToast('WhatsApp logged out', 'error');
    }

    updateUIState('disconnected');
    closeQRStream();
  });

  // Initial status
  eventSource.addEventListener('status', (event) => {
    const data = JSON.parse(event.data);
    updateUIState(data.status, data);
    if (data.status === 'connected') {
      closeQRStream();
    }
  });

  // Heartbeat
  eventSource.addEventListener('ping', () => {
    // Keep-alive
  });

  eventSource.onerror = () => {
    // EventSource will auto-reconnect, no action needed
  };
}

function closeQRStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// ── Pairing Code ───────────────────────────────────
async function requestPairingCode() {
  const phoneInput = document.getElementById('pairing-phone');
  const phoneNumber = phoneInput.value.trim();

  if (!phoneNumber) {
    showToast('⚠️ Masukkan nomor WhatsApp', 'error');
    return;
  }

  const btn = document.getElementById('btn-pairing');
  btn.disabled = true;
  btn.textContent = '⏳...';

  try {
    const resp = await fetch('/whatsapp/pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    });
    const json = await resp.json();

    if (json.success) {
      const resultEl = document.getElementById('pairing-result');
      const codeEl = document.getElementById('pairing-code');
      resultEl.classList.remove('hidden');
      codeEl.textContent = json.data.code;
      showToast('✅ Pairing code generated!');

      // Start SSE to monitor connection
      startQRStream();
    } else {
      showToast(`❌ ${json.message}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Code';
  }
}

// ── Disconnect ─────────────────────────────────────
async function disconnectWhatsApp() {
  if (!confirm('🔌 Disconnect WhatsApp?')) return;

  try {
    const resp = await fetch('/whatsapp/disconnect', { method: 'POST' });
    const json = await resp.json();

    if (json.success) {
      updateUIState('disconnected');
      closeQRStream();
      showToast('WhatsApp disconnected');
    } else {
      showToast(`❌ ${json.message}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  }
}

// ── Reset Session ──────────────────────────────────
async function resetSession() {
  if (!confirm('🗑️ Reset session data?\n\nIni akan menghapus semua data autentikasi.\nAnda perlu scan QR code lagi.')) return;

  const btn = document.getElementById('btn-reset');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Resetting...';
  }

  try {
    closeQRStream();
    const resp = await fetch('/whatsapp/reset', { method: 'POST' });
    const json = await resp.json();

    if (json.success) {
      updateUIState('disconnected');
      showToast('✅ Session cleared — silakan connect ulang');
    } else {
      showToast(`❌ ${json.message}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🗑️ Reset Session (jika QR/Pairing tidak berfungsi)';
    }
  }
}

// ── Chat History ───────────────────────────────────
async function refreshChatLogs() {
  try {
    const resp = await fetch('/whatsapp/chat-logs?limit=50');
    const json = await resp.json();

    if (!json.success) return;

    const container = document.getElementById('chat-history');
    const logs = json.data;

    if (!logs || logs.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8">
          <p class="text-sm text-surface-600">No messages yet</p>
        </div>
      `;
      return;
    }

    container.innerHTML = logs.map((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
      });

      if (log.type === 'in') {
        return `
          <div class="flex gap-2 items-start">
            <span class="text-[10px] text-surface-600 mt-2 w-12 flex-shrink-0">${time}</span>
            <div class="chat-in">
              <p class="text-[10px] text-accent font-medium mb-0.5">+${log.sender}</p>
              <p class="text-sm text-surface-200">${escapeHtml(log.text)}</p>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="flex gap-2 items-start justify-end">
            <div class="chat-out">
              <p class="text-[10px] text-accent/70 font-medium mb-0.5">BOT</p>
              <p class="text-sm text-surface-200 whitespace-pre-line">${escapeHtml(log.text)}</p>
            </div>
            <span class="text-[10px] text-surface-600 mt-2 w-12 flex-shrink-0 text-right">${time}</span>
          </div>
        `;
      }
    }).join('');

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  } catch {
    // Silently fail
  }
}

// ── Helpers ────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
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
