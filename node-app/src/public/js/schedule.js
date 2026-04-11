/**
 * Schedule Management — client-side JavaScript
 *
 * 3 Modes: Once Only, Weekly Repeat, Specific Date
 * Handles CRUD, mode switching, digit inputs, pickers, multi-select calendar
 */

// ── State ──────────────────────────────────────────
let schedules = [];
let sortOrder = 'desc';
let selectedType = 'power';
let selectedPowerAction = 'on';
let selectedMode = 'once';
let selectedDays = new Set();           // Weekly: set of 0-6
let selectedDates = [];                 // Specific: [{month, day}]
let specificSubMode = 'once';           // 'once' or 'repeat'

// Calendar state
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let specificCalYear = new Date().getFullYear();
let specificCalMonth = new Date().getMonth();

// Time picker state per mode prefix
let pickerHour = 0;
let pickerMinute = 0;
let activePickerPrefix = '';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_NAMES_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchSchedules();
  initTimePickerPopups();
  initCalendarPopup();
});

// ═══════════════════════════════════════════════════
// FETCH & RENDER
// ═══════════════════════════════════════════════════

async function fetchSchedules() {
  try {
    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'created_at';
    let url = `/api/schedules?sort=${sort}&order=${sortOrder}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.success) { schedules = json.data; renderSchedules(); updateCountBadge(); }
  } catch (err) { console.error('Fetch schedules error:', err); }
}

function renderSchedules() {
  const container = document.getElementById('schedule-list');
  if (schedules.length === 0) {
    container.innerHTML = `
      <div class="glass-card-static p-12 text-center animate-slide-up">
        <div class="w-16 h-16 rounded-2xl bg-surface-800 flex items-center justify-center mx-auto mb-4">
          <svg class="w-8 h-8 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        </div>
        <h3 class="text-lg font-semibold text-surface-300 mb-2">No Schedules Yet</h3>
        <p class="text-sm text-surface-500 mb-4">Create your first automated task</p>
        <button onclick="openModal()" class="btn-primary text-sm"><span class="flex items-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add Schedule</span></button>
      </div>`;
    return;
  }
  container.innerHTML = schedules.map((s, i) => {
    const isEnabled = s.is_enabled === 1 || s.is_enabled === true;
    const typeBadge = s.type === 'power'
      ? '<span class="badge badge-warning text-[10px]">⚡ Power</span>'
      : '<span class="badge badge-info text-[10px]">🔧 Redfish</span>';
    const actionText = s.type === 'power' ? (s.action === 'on' ? 'Power On' : 'Power Off') : truncate(s.action, 30);

    // Mode-specific display
    let modeText = '';
    const mode = s.schedule_mode || 'once';
    if (mode === 'once') {
      modeText = s.schedule_date ? `📅 ${formatDate(s.schedule_date)}` : '📅 Once';
    } else if (mode === 'weekly') {
      modeText = '🔄 Weekly';
    } else if (mode === 'specific') {
      const sr = s.specific_repeat === 1 || s.specific_repeat === true;
      modeText = `📋 Specific (${sr ? 'Repeat' : 'Once'})`;
    }

    const lastRunText = s.last_result
      ? (s.last_result.startsWith('success') ? '<span class="text-xs" style="color:oklch(0.72 0.19 165)">✅</span>' : '<span class="text-xs text-red-400">❌</span>')
      : '<span class="text-surface-600 text-xs">—</span>';

    return `
      <div class="glass-card-static p-4 animate-slide-up ${!isEnabled ? 'opacity-50' : ''}" style="animation-delay:${(i+2)*50}ms">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-start gap-4 flex-1 min-w-0">
            <div class="toggle-switch ${isEnabled ? 'active' : ''}" onclick="toggleSchedule(${s.id})"><div class="toggle-knob"></div></div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap mb-1">
                <span class="text-sm font-semibold text-surface-100 truncate">${esc(s.name)}</span>
                ${typeBadge}
              </div>
              <div class="flex items-center gap-3 flex-wrap text-xs text-surface-400">
                <span>${esc(actionText)}</span>
                <span>🕐 ${s.schedule_time}</span>
                <span>${modeText}</span>
                <span>Last: ${lastRunText}</span>
              </div>
              ${s.description ? `<p class="text-xs text-surface-500 mt-1 truncate">${esc(s.description)}</p>` : ''}
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button onclick="editSchedule(${s.id})" class="p-2 rounded-lg bg-surface-800/50 hover:bg-surface-700 border border-white/5 transition-colors" title="Edit">
              <svg class="w-4 h-4 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            </button>
            <button onclick="deleteSchedule(${s.id}, '${esc(s.name)}')" class="p-2 rounded-lg bg-surface-800/50 hover:bg-red-500/20 border border-white/5 hover:border-red-500/30 transition-colors" title="Delete">
              <svg class="w-4 h-4 text-surface-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function updateCountBadge() {
  const active = schedules.filter(s => s.is_enabled === 1 || s.is_enabled === true).length;
  const el = document.getElementById('schedule-count-text');
  if (el) el.textContent = `${active} Active`;
}

// ═══════════════════════════════════════════════════
// SEARCH & SORT
// ═══════════════════════════════════════════════════
let searchTimeout = null;
function handleSearch() { clearTimeout(searchTimeout); searchTimeout = setTimeout(fetchSchedules, 300); }
function handleSort() { fetchSchedules(); }
function toggleSortOrder() {
  sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
  document.getElementById('sort-order-icon').innerHTML = sortOrder === 'asc'
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4"/>'
    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"/>';
  fetchSchedules();
}

// ═══════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════
async function toggleSchedule(id) {
  try {
    const resp = await fetch(`/api/schedules/${id}/toggle`, { method: 'PATCH' });
    const json = await resp.json();
    if (json.success) { showToast(`📅 Schedule ${json.data.is_enabled ? 'enabled' : 'disabled'}`); fetchSchedules(); }
    else showToast(`❌ ${json.message}`, 'error');
  } catch (err) { showToast(`❌ ${err.message}`, 'error'); }
}
async function deleteSchedule(id, name) {
  if (!confirm(`🗑️ Delete "${name}"?`)) return;
  try {
    const resp = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    const json = await resp.json();
    if (json.success) { showToast('✅ Deleted'); fetchSchedules(); }
    else showToast(`❌ ${json.message}`, 'error');
  } catch (err) { showToast(`❌ ${err.message}`, 'error'); }
}
async function editSchedule(id) {
  try {
    const resp = await fetch(`/api/schedules/${id}`);
    const json = await resp.json();
    if (json.success) openModal(json.data);
  } catch { showToast('❌ Error loading schedule', 'error'); }
}

// ═══════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════
function openModal(schedule = null) {
  document.getElementById('schedule-form').reset();
  document.getElementById('edit-id').value = '';
  selectedDays = new Set();
  selectedDates = [];
  specificSubMode = 'once';
  selectedType = 'power';
  selectedPowerAction = 'on';
  selectType('power');
  selectPowerAction('on');

  // Reset all digit inputs
  document.querySelectorAll('.time-digit').forEach(el => el.value = '');

  if (schedule) {
    document.getElementById('modal-title').textContent = 'Edit Schedule';
    document.getElementById('btn-submit').textContent = 'Update Schedule';
    document.getElementById('edit-id').value = schedule.id;
    document.getElementById('field-name').value = schedule.name;
    document.getElementById('field-description').value = schedule.description || '';
    selectType(schedule.type);
    if (schedule.type === 'power') selectPowerAction(schedule.action);
    else document.getElementById('field-redfish-cmd').value = schedule.action;

    // Mode
    const mode = schedule.schedule_mode || 'once';
    selectMode(mode);

    if (mode === 'once' && schedule.schedule_date) {
      const [y, mo, d] = schedule.schedule_date.split('-');
      setDateDigits(d.padStart(2,'0'), mo.padStart(2,'0'), y.padStart(4,'0'));
    } else if (mode === 'once') {
      fillTodayDate();
    }

    if (mode === 'weekly' && schedule.days) {
      selectedDays = new Set(schedule.days);
      updateDayPillsUI();
    }

    if (mode === 'specific') {
      if (schedule.dates) selectedDates = [...schedule.dates];
      specificSubMode = (schedule.specific_repeat === 1 || schedule.specific_repeat === true) ? 'repeat' : 'once';
      selectSubMode(specificSubMode);
      renderSpecificCalendar();
      renderDateChips();
    }

    // Time
    if (schedule.schedule_time) {
      const [h, m] = schedule.schedule_time.split(':');
      setTimeByMode(mode, h.padStart(2,'0'), m.padStart(2,'0'));
    }
  } else {
    document.getElementById('modal-title').textContent = 'Add Schedule';
    document.getElementById('btn-submit').textContent = 'Save Schedule';
    selectMode('once');
    fillTodayDate();
  }

  document.getElementById('schedule-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('field-name').focus(), 100);
}

function closeModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

document.addEventListener('click', e => { if (e.target.id === 'schedule-modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ═══════════════════════════════════════════════════
// SUBMIT
// ═══════════════════════════════════════════════════
async function submitSchedule(event) {
  event.preventDefault();
  const editId = document.getElementById('edit-id').value;
  const name = document.getElementById('field-name').value.trim();

  // Get time from active mode
  const time = getTimeByMode(selectedMode);
  if (!time) return showToast('❌ Invalid time', 'error');

  // Action
  let action;
  if (selectedType === 'power') action = selectedPowerAction;
  else {
    action = document.getElementById('field-redfish-cmd').value.trim();
    if (!action) return showToast('❌ Redfish command required', 'error');
  }

  const body = {
    name, type: selectedType, action,
    schedule_time: time,
    schedule_mode: selectedMode,
    description: document.getElementById('field-description').value.trim(),
  };

  // Mode-specific data
  if (selectedMode === 'once') {
    const date = getDateFromDigits();
    if (date) body.schedule_date = date;
  } else if (selectedMode === 'weekly') {
    if (selectedDays.size === 0) return showToast('❌ Select at least 1 day', 'error');
    body.schedule_days = Array.from(selectedDays);
  } else if (selectedMode === 'specific') {
    if (selectedDates.length === 0) return showToast('❌ Select at least 1 date', 'error');
    body.schedule_dates = selectedDates;
    body.specific_repeat = specificSubMode === 'repeat';
  }

  try {
    const url = editId ? `/api/schedules/${editId}` : '/api/schedules';
    const method = editId ? 'PUT' : 'POST';
    const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await resp.json();
    if (json.success) { showToast(`✅ Schedule ${editId ? 'updated' : 'created'}!`); closeModal(); fetchSchedules(); }
    else showToast(`❌ ${json.message}`, 'error');
  } catch (err) { showToast(`❌ ${err.message}`, 'error'); }
}

// ═══════════════════════════════════════════════════
// TYPE & ACTION
// ═══════════════════════════════════════════════════
function selectType(type) {
  selectedType = type;
  document.getElementById('type-power').classList.toggle('active', type === 'power');
  document.getElementById('type-redfish').classList.toggle('active', type === 'redfish');
  document.getElementById('power-action-group').classList.toggle('hidden', type !== 'power');
  document.getElementById('redfish-action-group').classList.toggle('hidden', type !== 'redfish');
}
function selectPowerAction(action) {
  selectedPowerAction = action;
  document.getElementById('action-on-label').classList.toggle('active', action === 'on');
  document.getElementById('action-off-label').classList.toggle('active', action === 'off');
  document.querySelector(`input[name="power-action"][value="${action}"]`).checked = true;
}

// ═══════════════════════════════════════════════════
// MODE SWITCHING
// ═══════════════════════════════════════════════════
function selectMode(mode) {
  selectedMode = mode;
  ['once', 'weekly', 'specific'].forEach(m => {
    document.getElementById(`mode-tab-${m}`).classList.toggle('active', m === mode);
    document.getElementById(`mode-panel-${m}`).classList.toggle('hidden', m !== mode);
  });

  if (mode === 'specific') {
    renderSpecificCalendar();
    renderDateChips();
  }
}

// ═══════════════════════════════════════════════════
// DIGIT INPUTS (shared)
// ═══════════════════════════════════════════════════
function handleDigitKeydown(event, prevId, nextId) {
  if (event.key === 'Backspace' && !event.target.value && prevId) {
    event.preventDefault(); document.getElementById(prevId)?.focus();
  }
  if (event.key === 'ArrowLeft' && prevId) { event.preventDefault(); document.getElementById(prevId)?.focus(); }
  if (event.key === 'ArrowRight' && nextId) { event.preventDefault(); document.getElementById(nextId)?.focus(); }
}

function handleDateDigit(input, nextId) {
  input.value = input.value.replace(/\D/g, '');
  const id = input.id;
  if (id === 'date-d1' && input.value && parseInt(input.value) > 3) input.value = '3';
  if (id === 'date-d2' && document.getElementById('date-d1').value === '3' && parseInt(input.value) > 1) input.value = '1';
  if (id === 'date-m1' && input.value && parseInt(input.value) > 1) input.value = '1';
  if (id === 'date-m2' && document.getElementById('date-m1').value === '1' && parseInt(input.value) > 2) input.value = '2';
  if (input.value && nextId) document.getElementById(nextId)?.focus();
}

function handleTimeDigit(input, nextId) {
  input.value = input.value.replace(/\D/g, '');
  const id = input.id;
  const prefix = id.replace(/-?(h1|h2|m1|m2)$/, '');
  const h1Id = prefix ? `${prefix}-h1` : 'time-h1';
  if (id.endsWith('h1') && input.value && parseInt(input.value) > 2) input.value = '2';
  if (id.endsWith('h2')) {
    const h1 = document.getElementById(h1Id)?.value;
    if (h1 === '2' && input.value && parseInt(input.value) > 3) input.value = '3';
  }
  if (id.endsWith('m1') && input.value && parseInt(input.value) > 5) input.value = '5';
  if (input.value && nextId) document.getElementById(nextId)?.focus();
}

// ═══════════════════════════════════════════════════
// DATE HELPERS (Once mode)
// ═══════════════════════════════════════════════════
function fillTodayDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  setDateDigits(dd, mm, yyyy);
}

function setDateDigits(dd, mm, yyyy) {
  document.getElementById('date-d1').value = dd[0] || '';
  document.getElementById('date-d2').value = dd[1] || '';
  document.getElementById('date-m1').value = mm[0] || '';
  document.getElementById('date-m2').value = mm[1] || '';
  document.getElementById('date-y1').value = yyyy[0] || '';
  document.getElementById('date-y2').value = yyyy[1] || '';
  document.getElementById('date-y3').value = yyyy[2] || '';
  document.getElementById('date-y4').value = yyyy[3] || '';
}

function getDateFromDigits() {
  const dd = (document.getElementById('date-d1').value||'') + (document.getElementById('date-d2').value||'');
  const mm = (document.getElementById('date-m1').value||'') + (document.getElementById('date-m2').value||'');
  const yyyy = (document.getElementById('date-y1').value||'') + (document.getElementById('date-y2').value||'') +
               (document.getElementById('date-y3').value||'') + (document.getElementById('date-y4').value||'');
  if (dd.length === 2 && mm.length === 2 && yyyy.length === 4) return `${yyyy}-${mm}-${dd}`;
  return null;
}

// ═══════════════════════════════════════════════════
// TIME HELPERS (per mode)
// ═══════════════════════════════════════════════════
function getTimePrefix(mode) {
  if (mode === 'weekly') return 'wk-time';
  if (mode === 'specific') return 'sp-time';
  return 'time';
}

function getTimeByMode(mode) {
  const p = getTimePrefix(mode);
  const h = (document.getElementById(`${p}-h1`)?.value||'0') + (document.getElementById(`${p}-h2`)?.value||'0');
  const m = (document.getElementById(`${p}-m1`)?.value||'0') + (document.getElementById(`${p}-m2`)?.value||'0');
  const hour = parseInt(h), min = parseInt(m);
  if (isNaN(hour) || isNaN(min) || hour > 23 || min > 59) return null;
  return `${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
}

function setTimeByMode(mode, hh, mm) {
  const p = getTimePrefix(mode);
  document.getElementById(`${p}-h1`).value = hh[0] || '';
  document.getElementById(`${p}-h2`).value = hh[1] || '';
  document.getElementById(`${p}-m1`).value = mm[0] || '';
  document.getElementById(`${p}-m2`).value = mm[1] || '';
}

// ═══════════════════════════════════════════════════
// CALENDAR POPUP (Once mode)
// ═══════════════════════════════════════════════════
function initCalendarPopup() {
  const popup = document.getElementById('calendar-popup');
  const tpl = document.getElementById('tpl-calendar');
  if (!tpl || !popup) return;
  popup.appendChild(tpl.content.cloneNode(true));
  popup.querySelector('[data-action="prev"]').onclick = () => { calMonth--; if (calMonth < 0) { calMonth=11; calYear--; } renderOnceCalendar(); };
  popup.querySelector('[data-action="next"]').onclick = () => { calMonth++; if (calMonth > 11) { calMonth=0; calYear++; } renderOnceCalendar(); };
}

function toggleCalendar() {
  const popup = document.getElementById('calendar-popup');
  const isHidden = popup.classList.contains('hidden');
  closeAllPopups();
  if (isHidden) { popup.classList.remove('hidden'); renderOnceCalendar(); }
}

function renderOnceCalendar() {
  const popup = document.getElementById('calendar-popup');
  popup.querySelector('[data-role="label"]').textContent = `${MONTHS[calMonth]} ${calYear}`;
  const grid = popup.querySelector('[data-role="grid"]');
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<span></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cls = ds === todayStr ? 'cal-today' : (new Date(ds) < new Date(todayStr) ? 'cal-past' : '');
    html += `<button type="button" class="cal-day ${cls}" onclick="pickOnceDate(${d})">${d}</button>`;
  }
  grid.innerHTML = html;
}

function pickOnceDate(day) {
  setDateDigits(String(day).padStart(2,'0'), String(calMonth+1).padStart(2,'0'), String(calYear));
  document.getElementById('calendar-popup').classList.add('hidden');
  document.getElementById('time-h1')?.focus();
}

// ═══════════════════════════════════════════════════
// TIME PICKER POPUP (shared, per-mode)
// ═══════════════════════════════════════════════════
function initTimePickerPopups() {
  const tpl = document.getElementById('tpl-time-picker');
  if (!tpl) return;

  ['time-picker-popup', 'wk-time-picker-popup', 'sp-time-picker-popup'].forEach(popupId => {
    const popup = document.getElementById(popupId);
    if (!popup) return;
    popup.appendChild(tpl.content.cloneNode(true));
    popup.querySelector('[data-action="hour-up"]').onclick = () => adjustPicker('hour', 1, popupId);
    popup.querySelector('[data-action="hour-down"]').onclick = () => adjustPicker('hour', -1, popupId);
    popup.querySelector('[data-action="min-up"]').onclick = () => adjustPicker('minute', 1, popupId);
    popup.querySelector('[data-action="min-down"]').onclick = () => adjustPicker('minute', -1, popupId);
    popup.querySelector('[data-action="apply"]').onclick = () => applyTimePicker(popupId);
  });
}

function toggleTimePicker(prefix) {
  prefix = prefix || '';
  const popupId = prefix ? `${prefix}-time-picker-popup` : 'time-picker-popup';
  const popup = document.getElementById(popupId);
  const isHidden = popup.classList.contains('hidden');
  closeAllPopups();
  if (isHidden) {
    activePickerPrefix = prefix;
    const p = prefix ? `${prefix}-time` : 'time';
    const h = parseInt((document.getElementById(`${p}-h1`)?.value||'0') + (document.getElementById(`${p}-h2`)?.value||'0')) || 0;
    const m = parseInt((document.getElementById(`${p}-m1`)?.value||'0') + (document.getElementById(`${p}-m2`)?.value||'0')) || 0;
    pickerHour = Math.min(h, 23);
    pickerMinute = Math.min(m, 59);
    popup.querySelector('[data-role="hour"]').textContent = String(pickerHour).padStart(2,'0');
    popup.querySelector('[data-role="minute"]').textContent = String(pickerMinute).padStart(2,'0');
    popup.classList.remove('hidden');
  }
}

function adjustPicker(type, delta, popupId) {
  const popup = document.getElementById(popupId);
  if (type === 'hour') {
    pickerHour = (pickerHour + delta + 24) % 24;
    popup.querySelector('[data-role="hour"]').textContent = String(pickerHour).padStart(2,'0');
  } else {
    pickerMinute = (pickerMinute + delta + 60) % 60;
    popup.querySelector('[data-role="minute"]').textContent = String(pickerMinute).padStart(2,'0');
  }
}

function applyTimePicker(popupId) {
  const hh = String(pickerHour).padStart(2,'0');
  const mm = String(pickerMinute).padStart(2,'0');
  const p = activePickerPrefix ? `${activePickerPrefix}-time` : 'time';
  document.getElementById(`${p}-h1`).value = hh[0];
  document.getElementById(`${p}-h2`).value = hh[1];
  document.getElementById(`${p}-m1`).value = mm[0];
  document.getElementById(`${p}-m2`).value = mm[1];
  document.getElementById(popupId).classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// WEEKLY — DAY PILLS
// ═══════════════════════════════════════════════════
function toggleDay(day) {
  if (selectedDays.has(day)) selectedDays.delete(day);
  else selectedDays.add(day);
  updateDayPillsUI();
}

function updateDayPillsUI() {
  document.querySelectorAll('.day-pill').forEach(btn => {
    const d = parseInt(btn.dataset.day);
    btn.classList.toggle('active', selectedDays.has(d));
  });
}

// ═══════════════════════════════════════════════════
// SPECIFIC DATE — MULTI-SELECT CALENDAR
// ═══════════════════════════════════════════════════
function selectSubMode(mode) {
  specificSubMode = mode;
  document.getElementById('sub-mode-once').classList.toggle('active', mode === 'once');
  document.getElementById('sub-mode-repeat').classList.toggle('active', mode === 'repeat');
  document.getElementById('sub-mode-hint').textContent =
    mode === 'once' ? 'Schedule will auto-disable after the last selected date'
                    : 'Schedule will repeat on selected dates every year';
  // Re-render to update past-date selectability
  renderSpecificCalendar();
}

function specificCalNav(delta) {
  specificCalMonth += delta;
  if (specificCalMonth > 11) { specificCalMonth = 0; specificCalYear++; }
  if (specificCalMonth < 0) { specificCalMonth = 11; specificCalYear--; }
  // Keep within current year
  const thisYear = new Date().getFullYear();
  if (specificCalYear < thisYear) { specificCalYear = thisYear; specificCalMonth = 0; }
  if (specificCalYear > thisYear) { specificCalYear = thisYear; specificCalMonth = 11; }
  renderSpecificCalendar();
}

function renderSpecificCalendar() {
  const label = document.getElementById('specific-cal-label');
  const grid = document.getElementById('specific-cal-grid');
  if (!label || !grid) return;

  label.textContent = `${MONTHS[specificCalMonth]} ${specificCalYear}`;
  const firstDay = new Date(specificCalYear, specificCalMonth, 1).getDay();
  const daysInMonth = new Date(specificCalYear, specificCalMonth + 1, 0).getDate();
  const today = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();
  const month = specificCalMonth + 1;

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<span></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const isSelected = selectedDates.some(x => x.month === month && x.day === d);
    const isPast = specificSubMode === 'once' && (month < todayMonth || (month === todayMonth && d < todayDay));
    const cls = [
      'cal-day',
      isSelected ? 'cal-selected' : '',
      isPast ? 'cal-past cal-disabled' : ''
    ].join(' ');
    html += `<button type="button" class="${cls}" onclick="toggleSpecificDate(${month}, ${d})" ${isPast ? 'disabled' : ''}>${d}</button>`;
  }
  grid.innerHTML = html;
}

function toggleSpecificDate(month, day) {
  const idx = selectedDates.findIndex(x => x.month === month && x.day === day);
  if (idx >= 0) selectedDates.splice(idx, 1);
  else selectedDates.push({ month, day });
  selectedDates.sort((a, b) => a.month - b.month || a.day - b.day);
  renderSpecificCalendar();
  renderDateChips();
}

function renderDateChips() {
  const container = document.getElementById('selected-dates-chips');
  if (!container) return;
  if (selectedDates.length === 0) {
    container.innerHTML = '<span class="text-xs text-surface-600">No dates selected</span>';
    return;
  }
  container.innerHTML = selectedDates.map(d =>
    `<span class="date-chip">${String(d.day).padStart(2,'0')} ${MONTHS[d.month-1].substring(0,3)}<button type="button" class="date-chip-x" onclick="removeSpecificDate(${d.month},${d.day})">×</button></span>`
  ).join('');
}

function removeSpecificDate(month, day) {
  const idx = selectedDates.findIndex(x => x.month === month && x.day === day);
  if (idx >= 0) selectedDates.splice(idx, 1);
  renderSpecificCalendar();
  renderDateChips();
}

// ═══════════════════════════════════════════════════
// POPUP MANAGEMENT
// ═══════════════════════════════════════════════════
function closeAllPopups() {
  document.querySelectorAll('.picker-popup').forEach(p => {
    if (!p.closest('.mode-panel') || p.id) p.classList.add('hidden');
  });
}

document.addEventListener('click', e => {
  // Close popups when clicking outside
  document.querySelectorAll('.picker-popup:not(.hidden)').forEach(popup => {
    if (popup.id && !popup.contains(e.target) && !e.target.closest('.picker-icon-btn')) {
      popup.classList.add('hidden');
    }
  });
});

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
function esc(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = String(str); return d.innerHTML; }
function truncate(str, len) { if (!str) return ''; return str.length > len ? str.substring(0, len) + '...' : str; }
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try { const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return dateStr; }
}
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-6 right-6 ${type === 'error' ? 'bg-red-500/90' : 'bg-green-500/90'} text-white px-5 py-3 rounded-xl text-sm font-medium shadow-2xl z-[60] animate-slide-up backdrop-blur-sm`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}
