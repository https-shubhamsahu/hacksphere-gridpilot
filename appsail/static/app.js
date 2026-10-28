/* GridPilot dashboard: HackSphere 3.0, Team NO SUS */
(() => {
  'use strict';

  const API = {
    health: 'api/health',
    sample: 'api/sample',
    forecast: 'api/forecast',
    csv: 'api/forecast/csv',
    logs: 'api/logs',
  };
  const RULE = { storage: 160, overload: 200, winStart: 18, winEnd: 22, lowSoc: 20 };
  const BATTERY = { capacity_kwh: 500, initial_soc_pct: 80 };
  const COLS = ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2'];
  const C = {
    teal: '#2DD4BF', blue: '#60A5FA', red: '#EF4444', redSoft: '#F87171', amber: '#FBBF24',
    solar: 'rgba(253, 224, 71, 0.55)', grid: 'rgba(148, 163, 184, 0.08)', muted: '#8B98A9', text: '#E6EDF3',
  };
  const STEP_MS = 1500;

  const state = {
    rows: [], summary: null, signals: [], cleaning: null, source: null,
    sel: 0, playing: false, timer: null, health: null, charts: {},
    sample: [], lastRunAt: null, dismissed: new Set(), busy: false,
  };

  /* ---------- helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fmt = (v, d = 1) => (Number.isFinite(num(v)) ? num(v).toFixed(d) : '--');
  const fmtInt = (v) => (Number.isFinite(num(v)) ? Math.round(num(v)).toLocaleString('en-IN') : '--');
  const pad = (n) => String(n).padStart(2, '0');
  const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const isStorage = (r) => r && r.grid_mode === 'RENEWABLE_STORAGE';

  function hourLabel(ts) {
    const m = /[ T](\d{1,2}):(\d{2})/.exec(String(ts || ''));
    return m ? `${pad(m[1])}:${m[2]}` : String(ts || '--');
  }
  function hourNum(ts) {
    const m = /[ T](\d{1,2}):/.exec(String(ts || ''));
    return m ? Number(m[1]) : NaN;
  }
  function dateLabel(ts) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts || ''));
    return m ? m[1] : '';
  }
  function inWindow(ts) {
    const h = hourNum(ts);
    return h >= RULE.winStart && h <= RULE.winEnd;
  }
  function parseTs(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(ts || '').trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  function fmtTs(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  async function fetchJSON(url, opts = {}, timeoutMs = 45000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
      let body = null;
      const text = await res.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!res.ok) {
        const msg = (body && (body.error || body.message || body.detail)) || `${res.status} ${res.statusText || 'error'}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      if (body === null) throw new Error('Server returned a non-JSON response');
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  function toast(msg, type = 'error', ms = 6000) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ic = type === 'ok' ? 'i-check' : 'i-alert';
    el.innerHTML = `${icon(ic, '')}<span class="t-msg">${esc(msg)}</span><button class="btn icon-btn xs" type="button" aria-label="Dismiss notification">${icon('i-x')}</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.remove(), ms);
  }

  function setBusy(on) {
    state.busy = on;
    document.body.classList.toggle('is-busy', on);
    ['#btn-run', '#btn-sample'].forEach((s) => { const b = $(s); if (b) b.disabled = on; });
  }

  /* ---------- clock ---------- */
  function tickClock() {
    const d = new Date();
    $('#clock-time').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    let tz = '';
    try { tz = new Intl.DateTimeFormat('en-IN', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { /* noop */ }
    $('#clock-date').textContent = `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}${tz ? ' · ' + tz : ''}`;
  }

  /* ---------- health ---------- */
  async function loadHealth() {
    const pill = $('#api-pill');
    try {
      const h = await fetchJSON(API.health, {}, 15000);
      state.health = h;
      pill.className = 'status-pill ' + (h.status === 'ok' ? 'is-ok' : 'is-err');
      renderPill();
    } catch (e) {
      state.health = null;
      pill.className = 'status-pill is-err';
      $('#api-pill-main').textContent = 'API offline';
      $('#api-pill-sub').textContent = e.message;
    }
  }
  function renderPill() {
    const h = state.health;
    if (!h) return;
    const src = state.source ? state.source : (h.quickml_configured ? 'quickml' : 'local');
    const srcLabel = src === 'quickml' ? 'QuickML' : 'local model';
    $('#api-pill-main').textContent = h.status === 'ok' ? `API online · ${srcLabel}` : `API ${h.status || 'degraded'}`;
    const parts = [];
    if (h.model) parts.push(h.model + (h.model_version ? ` v${h.model_version}` : ''));
    if (Number.isFinite(num(h.validation_rmse))) parts.push(`RMSE ${fmt(h.validation_rmse, 2)} kW`);
    $('#api-pill-sub').textContent = parts.join(' · ');
    $('#api-pill').title = `Model: ${h.model || '?'} ${h.model_version || ''}\nSource: ${srcLabel}\nValidation RMSE: ${fmt(h.validation_rmse, 3)}\nQuickML configured: ${h.quickml_configured ? 'yes' : 'no'}\nServer time: ${h.time || '?'}`;
  }

  /* ---------- logs ---------- */
  async function loadLogs() {
    try {
      const res = await fetchJSON(API.logs, {}, 15000);
      const events = Array.isArray(res.events) ? res.events.slice(-80).reverse() : [];
      const ol = $('#syslog');
      if (!events.length) { ol.innerHTML = '<li class="empty">No events logged yet</li>'; }
      else {
        ol.innerHTML = events.map((ev) => {
          const lvl = ['INFO', 'WARN', 'ALERT'].includes(ev.level) ? ev.level : 'INFO';
          return `<li><span class="t">${esc(shortTime(ev.time))}</span><span class="ev ${lvl}">${lvl}</span><span class="d">${esc(ev.message)}</span></li>`;
        }).join('');
      }
      const d = new Date();
      $('#sys-updated').textContent = `updated ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (e) {
      $('#sys-updated').textContent = 'log feed unavailable';
    }
  }
  function shortTime(t) {
    const m = /(\d{2}:\d{2}:\d{2})/.exec(String(t || ''));
    return m ? m[1] : String(t || '');
  }

  /* ---------- sample + manual table ---------- */
  async function loadSample(runAfter = false) {
    setBusy(true);
    try {
      const res = await fetchJSON(API.sample);
      const rows = Array.isArray(res.data) ? res.data : [];
      if (!rows.length) throw new Error('Sample endpoint returned no rows');
      state.sample = rows;
      fillManual(rows);
      if (runAfter) await runForecast(rows, 'sample');
      else toast(`Loaded ${rows.length} sample hours into manual entry`, 'ok', 3500);
    } catch (e) {
      toast(`Could not load sample data: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function manualRowHTML(r = {}) {
    const v = (k) => (r[k] === null || r[k] === undefined ? '' : esc(r[k]));
    return `<tr>
      <td><input class="ts" type="text" value="${v('timestamp')}" placeholder="YYYY-MM-DD HH:MM:SS" aria-label="Timestamp" spellcheck="false"></td>
      <td><input type="number" step="0.1" inputmode="decimal" value="${v('ambient_temp_c')}" aria-label="Ambient temperature in degrees Celsius"></td>
      <td><input type="number" step="0.1" inputmode="decimal" value="${v('humidity_pct')}" aria-label="Humidity percent"></td>
      <td><input type="number" step="1" inputmode="decimal" value="${v('solar_irradiance_wm2')}" aria-label="Solar irradiance in watts per square metre"></td>
      <td><button class="btn icon-btn xs row-del" type="button" aria-label="Remove this hour">${icon('i-x')}</button></td>
    </tr>`;
  }
  function fillManual(rows) {
    $('#manual-body').innerHTML = rows.map(manualRowHTML).join('');
    updateManualCount();
  }
  function updateManualCount() {
    const n = $('#manual-body').children.length;
    $('#manual-count').textContent = `${n} row${n === 1 ? '' : 's'}`;
  }
  function readManual() {
    const out = [];
    $('#manual-body').querySelectorAll('tr').forEach((tr) => {
      const ins = tr.querySelectorAll('input');
      const ts = ins[0].value.trim();
      const vals = [1, 2, 3].map((i) => { const s = ins[i].value.trim(); return s === '' ? null : Number(s); });
      if (!ts && vals.every((x) => x === null)) return;
      ins[0].classList.toggle('invalid', !parseTs(ts));
      out.push({ timestamp: ts, ambient_temp_c: vals[0], humidity_pct: vals[1], solar_irradiance_wm2: vals[2] });
    });
    return out;
  }
  function addHour() {
    const body = $('#manual-body');
    const last = body.lastElementChild;
    let next = {};
    if (last) {
      const ins = last.querySelectorAll('input');
      const d = parseTs(ins[0].value);
      next = {
        timestamp: d ? fmtTs(new Date(d.getTime() + 3600000)) : '',
        ambient_temp_c: ins[1].value, humidity_pct: ins[2].value, solar_irradiance_wm2: ins[3].value,
      };
    } else {
      const d = new Date(); d.setMinutes(0, 0, 0);
      next = { timestamp: fmtTs(d) };
    }
    body.insertAdjacentHTML('beforeend', manualRowHTML(next));
    updateManualCount();
    const tr = body.lastElementChild;
    tr.scrollIntoView({ block: 'nearest' });
    tr.querySelector('input').focus();
  }

  /* ---------- forecast ---------- */
  async function runForecast(rows, label = 'manual') {
    if (!rows || !rows.length) { toast('Add at least one hour of data before running a forecast', 'warn'); return; }
    setBusy(true);
    try {
      const res = await fetchJSON(API.forecast, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rows, battery: BATTERY }),
      });
      applyResult(res, label);
    } catch (e) {
      toast(`Forecast failed: ${e.message}`);
    } finally {
      setBusy(false);
      loadLogs();
    }
  }
  async function runCsv(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type && !/csv|text\/plain|excel/i.test(file.type)) {
      toast(`"${file.name}" is not a CSV file`, 'warn');
      return;
    }
    $('#dz-file').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · uploading`;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetchJSON(API.csv, { method: 'POST', body: fd });
      applyResult(res, file.name);
      $('#dz-file').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · forecast ready`;
    } catch (e) {
      $('#dz-file').textContent = `${file.name} · upload failed`;
      toast(`CSV forecast failed: ${e.message}`);
    } finally {
      setBusy(false);
      $('#file-input').value = '';
      loadLogs();
    }
  }

  function applyResult(res, label) {
    const rows = Array.isArray(res && res.rows) ? res.rows : [];
    if (!rows.length) throw new Error('Forecast returned no rows');
    state.rows = rows;
    state.summary = res.summary || computeSummary(rows);
    state.signals = Array.isArray(res.signals) ? res.signals : [];
    state.cleaning = res.cleaning || null;
    state.source = res.model_source || null;
    state.lastRunAt = new Date();
    state.runLabel = label;
    state.dismissed.clear();

    // Start the replay at the current wall-clock hour when it exists in the horizon
    const nowH = new Date().getHours();
    const idx = rows.findIndex((r) => hourNum(r.timestamp) === nowH);
    state.sel = idx >= 0 ? idx : 0;

    const range = $('#hour-range');
    range.max = String(rows.length - 1);

    renderAll();
    renderPill();
    startPlay();
    const s = state.summary;
    toast(`Forecast ready: ${rows.length} h, peak ${fmt(s.peak_demand_kw)} kW at ${hourLabel(s.peak_hour) || s.peak_hour}`, 'ok', 3500);
  }

  function computeSummary(rows) {
    const d = rows.map((r) => num(r.predicted_demand_kw));
    let pi = 0; d.forEach((v, i) => { if (v > d[pi]) pi = i; });
    let trans = 0; rows.forEach((r, i) => { if (i && r.grid_mode !== rows[i - 1].grid_mode) trans++; });
    return {
      peak_demand_kw: d[pi], peak_hour: rows[pi].timestamp,
      avg_demand_kw: d.reduce((a, b) => a + b, 0) / d.length,
      total_energy_kwh: d.reduce((a, b) => a + b, 0),
      storage_hours: rows.filter(isStorage).length,
      grid_hours: rows.filter((r) => !isStorage(r)).length,
      overload_hours: rows.filter((r) => r.overload_alert).length,
      transitions: trans,
      min_soc_pct: Math.min(...rows.map((r) => num(r.battery_soc_pct))),
    };
  }

  /* ---------- render ---------- */
  function renderAll() {
    renderBanners();
    renderKPIs();
    renderTimeline();
    renderCharts();
    renderSignals();
    renderCleaning();
    renderTable();
    renderMeta();
    select(state.sel, false);
  }

  function renderMeta() {
    const r0 = state.rows[0];
    const rN = state.rows[state.rows.length - 1];
    const src = state.source === 'quickml' ? 'QuickML' : state.source === 'local' ? 'local model' : 'model';
    const at = state.lastRunAt;
    $('#run-meta').textContent = `${dateLabel(r0.timestamp)} ${hourLabel(r0.timestamp)} to ${hourLabel(rN.timestamp)} · ${state.rows.length} h horizon · ${src} · generated ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    $('#clean-src').textContent = state.runLabel === 'sample' ? 'sample 24 h' : String(state.runLabel || '');
  }

  function renderBanners() {
    const box = $('#banners');
    const items = [];
    const over = state.rows.filter((r) => r.overload_alert);
    if (over.length && !state.dismissed.has('overload')) {
      const worst = over.reduce((a, b) => (num(b.predicted_demand_kw) > num(a.predicted_demand_kw) ? b : a));
      const hours = over.map((r) => hourLabel(r.timestamp));
      items.push({
        key: 'overload', cls: 'critical', ic: 'i-alert', jump: state.rows.indexOf(worst),
        title: `Critical overload forecast at ${hourLabel(worst.timestamp)} — ${fmt(worst.predicted_demand_kw)} kW`,
        sub: `${over.length} hour${over.length > 1 ? 's' : ''} at or above ${RULE.overload} kW (${hours.join(', ')}). Pre-charge storage and shed non-critical load before the peak.`,
      });
    }
    const socs = state.rows.map((r) => num(r.battery_soc_pct));
    const minSoc = Number.isFinite(num(state.summary && state.summary.min_soc_pct)) ? num(state.summary.min_soc_pct) : Math.min(...socs);
    if (Number.isFinite(minSoc) && minSoc < RULE.lowSoc && !state.dismissed.has('soc')) {
      const i = socs.indexOf(Math.min(...socs));
      items.push({
        key: 'soc', cls: 'warn', ic: 'i-battery', jump: i,
        title: `Battery reserve low — SoC falls to ${fmt(minSoc)}%${i >= 0 ? ` at ${hourLabel(state.rows[i].timestamp)}` : ''}`,
        sub: `Below the ${RULE.lowSoc}% reserve floor on a ${BATTERY.capacity_kwh} kWh bank. Expect the main grid to cover storage hours after depletion.`,
      });
    }
    const warns = (state.cleaning && state.cleaning.warnings) || [];
    if (warns.length && !state.dismissed.has('clean')) {
      items.push({ key: 'clean', cls: 'warn', ic: 'i-db', jump: -1, title: `Input data needed cleaning — ${warns.length} warning${warns.length > 1 ? 's' : ''}`, sub: warns.slice(0, 2).join(' · ') });
    }
    box.innerHTML = items.map((b) => `
      <div class="banner ${b.cls}" role="${b.cls === 'critical' ? 'alert' : 'status'}" data-key="${b.key}">
        ${icon(b.ic, 'b-ic')}
        <div class="b-body"><div class="b-title">${esc(b.title)}</div><div class="b-sub">${esc(b.sub)}</div></div>
        <div class="b-actions">
          ${b.jump >= 0 ? `<button class="btn sm ${b.cls === 'critical' ? 'danger-ghost' : 'ghost'}" type="button" data-jump="${b.jump}">View hour</button>` : ''}
          <button class="btn icon-btn xs" type="button" data-dismiss="${b.key}" aria-label="Dismiss alert">${icon('i-x')}</button>
        </div>
      </div>`).join('');
  }

  function renderKPIs() {
    const s = state.summary || {};
    $('#k-peak').textContent = fmt(s.peak_demand_kw);
    $('#k-peak-hour').textContent = s.peak_hour ? `at ${hourLabel(s.peak_hour)}` : '';
    $('#k-energy').textContent = fmtInt(s.total_energy_kwh);
    $('#k-avg').textContent = `avg ${fmt(s.avg_demand_kw)} kW`;
    $('#k-storage').textContent = fmtInt(s.storage_hours);
    $('#k-grid').textContent = fmtInt(s.grid_hours);
    const tot = num(s.storage_hours) + num(s.grid_hours);
    $('#k-split').style.width = tot > 0 ? `${(num(s.storage_hours) / tot) * 100}%` : '0';
    $('#k-trans').textContent = fmtInt(s.transitions);
    $('#k-over').textContent = fmtInt(s.overload_hours);
    $('#k-soc').textContent = fmt(s.min_soc_pct);
    $('#kpi-overload').classList.toggle('hot', num(s.overload_hours) > 0);
    $('#kpi-soc').classList.toggle('low', num(s.min_soc_pct) < RULE.lowSoc);
  }

  function renderTimeline() {
    const max = Math.max(RULE.overload * 1.1, ...state.rows.map((r) => num(r.predicted_demand_kw)).filter(Number.isFinite));
    $('#timeline').innerHTML = state.rows.map((r, i) => {
      const d = num(r.predicted_demand_kw);
      const h = Math.max(6, Math.min(100, (d / max) * 100));
      const mode = isStorage(r) ? 'storage' : 'grid';
      const label = `${hourLabel(r.timestamp)}, ${fmt(d)} kW, ${mode === 'storage' ? 'renewable storage' : 'main grid'}${r.overload_alert ? ', critical overload' : ''}`;
      return `<button type="button" role="option" class="tl-cell ${mode}${r.overload_alert ? ' over' : ''}${inWindow(r.timestamp) ? ' peak-window' : ''}" data-i="${i}" aria-label="${esc(label)}" aria-selected="false">
        <span class="tl-fill" style="height:${h.toFixed(0)}%"></span>
        ${r.overload_alert ? '<span class="tl-alert" aria-hidden="true"></span>' : ''}
        <span>${pad(hourNum(r.timestamp))}</span>
      </button>`;
    }).join('');
  }

  function showTip(cell) {
    const r = state.rows[+cell.dataset.i];
    if (!r) return;
    const tip = $('#tl-tip');
    const mode = isStorage(r) ? '<span class="mb storage">STORAGE</span>' : '<span class="mb grid">GRID</span>';
    const reasons = Array.isArray(r.reasons) && r.reasons.length ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    tip.innerHTML = `<div class="tt-head"><span class="mono">${esc(hourLabel(r.timestamp))}</span>${mode}</div>
      <div class="tt-row mono">${fmt(r.predicted_demand_kw)} kW · SoC ${fmt(r.battery_soc_pct)}% · solar ${fmt(r.solar_generation_kw)} kW</div>
      ${r.overload_alert ? `<div class="tt-row" style="color:var(--red);font-weight:700;margin-top:4px">Critical overload (&ge; ${RULE.overload} kW)</div>` : ''}
      ${reasons}`;
    tip.hidden = false;
    const b = cell.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = b.left + b.width / 2 - tw / 2;
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
    let top = b.top - th - 8;
    if (top < 60) top = b.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() { $('#tl-tip').hidden = true; }

  function renderSignals() {
    const ol = $('#signals');
    $('#sig-count').textContent = String(state.signals.length);
    if (!state.signals.length) { ol.innerHTML = '<li class="empty">No dispatch events in this horizon</li>'; return; }
    const map = {
      SWITCH_TO_STORAGE: { cls: 'storage', ic: 'i-battery', txt: 'TO STORAGE' },
      SWITCH_TO_GRID: { cls: 'grid', ic: 'i-pylon', txt: 'TO GRID' },
      OVERLOAD_ALERT: { cls: 'alert', ic: 'i-alert', txt: 'OVERLOAD' },
    };
    ol.innerHTML = state.signals.map((s) => {
      const m = map[s.event] || { cls: 'grid', ic: 'i-switch', txt: s.event };
      const i = state.rows.findIndex((r) => r.timestamp === s.timestamp);
      return `<li data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${hourLabel(s.timestamp)} ${s.event}: ${s.detail || ''}`)}"><span class="t">${esc(hourLabel(s.timestamp))}</span><span class="ev ${m.cls}">${icon(m.ic, '')}${esc(m.txt)}</span><span class="d">${esc(s.detail || '')}</span></li>`;
    }).join('');
  }

  function renderCleaning() {
    const c = state.cleaning;
    const box = $('#cleaning');
    if (!c) { box.innerHTML = '<p class="muted">No cleaning report returned for this run.</p>'; return; }
    const tags = (obj) => Object.entries(obj || {}).filter(([, n]) => num(n) > 0).map(([k, n]) => `<span class="c-tag">${esc(k)} ×${esc(n)}</span>`).join('');
    const imp = tags(c.imputed), clip = tags(c.clipped);
    const warns = Array.isArray(c.warnings) ? c.warnings : [];
    const clean = !imp && !clip && !warns.length && !num(c.dropped);
    box.innerHTML = `
      <div class="c-stats">
        <div class="c-stat"><span>Rows in</span><b>${fmtInt(c.rows_in)}</b></div>
        <div class="c-stat"><span>Rows out</span><b>${fmtInt(c.rows_out)}</b></div>
        <div class="c-stat"><span>Dropped</span><b style="color:${num(c.dropped) > 0 ? 'var(--amber)' : 'inherit'}">${fmtInt(c.dropped)}</b></div>
      </div>
      <p class="c-line">Imputed: ${imp || '<span>none</span>'}</p>
      <p class="c-line">Clipped: ${clip || '<span>none</span>'}</p>
      ${warns.length ? `<ul class="c-warn">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${clean ? `<p class="c-ok">${icon('i-check')}Input passed validation with no fixes needed</p>` : ''}`;
  }

  function renderTable() {
    $('#table-count').textContent = `${state.rows.length} rows`;
    $('#ftable-body').innerHTML = state.rows.map((r, i) => {
      const st = isStorage(r);
      return `<tr data-i="${i}" class="${r.overload_alert ? 'over' : ''}">
        <td class="mono">${esc(hourLabel(r.timestamp))}</td>
        <td class="num">${fmt(r.ambient_temp_c)}</td>
        <td class="num">${fmt(r.humidity_pct)}</td>
        <td class="num">${fmt(r.solar_irradiance_wm2, 0)}</td>
        <td class="num">${fmt(r.solar_generation_kw)}</td>
        <td class="num" style="font-weight:700;${num(r.predicted_demand_kw) >= RULE.overload ? 'color:var(--red)' : ''}">${fmt(r.predicted_demand_kw)}</td>
        <td>${st ? `<span class="mb storage">${icon('i-battery', '')}STORAGE</span>` : `<span class="mb grid">${icon('i-pylon', '')}GRID</span>`}</td>
        <td class="num">${fmt(r.battery_soc_pct)}</td>
        <td>${r.overload_alert ? `<span class="mb alert">${icon('i-alert', '')}OVERLOAD</span>` : '<span class="muted">—</span>'}</td>
        <td class="reasons-cell">${esc((r.reasons || []).join('; '))}</td>
      </tr>`;
    }).join('');
  }

  /* ---------- selection / status strip ---------- */
  function select(i, fromUser = false) {
    if (!state.rows.length) return;
    i = Math.max(0, Math.min(state.rows.length - 1, i | 0));
    state.sel = i;
    if (fromUser) stopPlay();
    const r = state.rows[i];
    const prev = state.rows[i - 1];
    const st = isStorage(r);
    const d = num(r.predicted_demand_kw);

    $('#strip-hour').textContent = hourLabel(r.timestamp);
    $('#hour-range').value = String(i);
    $('#hour-range').setAttribute('aria-valuetext', `${hourLabel(r.timestamp)}, ${fmt(d)} kilowatts`);

    // Mode tile
    const tile = $('#mode-tile');
    tile.classList.toggle('is-storage', st);
    tile.classList.toggle('is-grid', !st);
    tile.querySelector('.mode-icon').innerHTML = `<svg aria-hidden="true"><use href="#${st ? 'i-battery' : 'i-pylon'}"/></svg>`;
    $('#mode-name').textContent = st ? 'Renewable Storage' : 'Main Grid';
    $('#mode-code').textContent = r.grid_mode || '--';
    let a = i; while (a > 0 && state.rows[a - 1].grid_mode === r.grid_mode) a--;
    let b = i; while (b < state.rows.length - 1 && state.rows[b + 1].grid_mode === r.grid_mode) b++;
    const nextSwitch = b < state.rows.length - 1 ? `next switch ${hourLabel(state.rows[b + 1].timestamp)}` : 'holds to end of horizon';
    $('#mode-since').textContent = `Active since ${hourLabel(state.rows[a].timestamp)} · ${nextSwitch}`;

    // Demand
    $('#demand-now').textContent = fmt(d);
    const scaleMax = 250;
    const fill = $('#load-fill');
    fill.style.width = `${Math.max(2, Math.min(100, (d / scaleMax) * 100))}%`;
    fill.className = 'load-fill' + (d >= RULE.overload ? ' over' : st ? ' storage' : '');
    if (prev) {
      const delta = d - num(prev.predicted_demand_kw);
      $('#demand-delta').textContent = `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} kW vs ${hourLabel(prev.timestamp)} · ${fmt(r.ambient_temp_c)} °C`;
    } else {
      $('#demand-delta').textContent = `first hour · ${fmt(r.ambient_temp_c)} °C ambient`;
    }

    // SoC
    const soc = num(r.battery_soc_pct);
    const circ = 2 * Math.PI * 32;
    const arc = $('#soc-arc');
    arc.style.strokeDasharray = `${circ}`;
    arc.style.strokeDashoffset = `${circ * (1 - Math.max(0, Math.min(100, Number.isFinite(soc) ? soc : 0)) / 100)}`;
    $('#soc-now').textContent = fmt(soc);
    $('#soc-kwh').textContent = Number.isFinite(soc) ? `${fmtInt((soc / 100) * BATTERY.capacity_kwh)} / ${BATTERY.capacity_kwh} kWh` : '';
    document.querySelector('.soc-tile').classList.toggle('low', soc < RULE.lowSoc);
    $('#solar-now').textContent = `Solar ${fmt(r.solar_generation_kw)} kW · ${fmt(r.solar_irradiance_wm2, 0)} W/m²`;

    // Overload
    const olTile = $('#overload-tile');
    const over = !!r.overload_alert;
    olTile.classList.toggle('alarm', over);
    $('#ol-state').innerHTML = `${icon(over ? 'i-alert' : 'i-check')}<span>${over ? 'CRITICAL OVERLOAD' : 'Nominal'}</span>`;
    const margin = RULE.overload - d;
    $('#ol-margin').textContent = Number.isFinite(margin) ? (margin > 0 ? `${margin.toFixed(1)} kW headroom to ${RULE.overload} kW` : `${Math.abs(margin).toFixed(1)} kW over the ${RULE.overload} kW limit`) : '';

    // Reasons
    const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons : [st ? 'Storage rule matched' : 'No storage trigger: demand at or below 160 kW outside 18:00–22:00'];
    $('#reasons').innerHTML = reasons.map((x) => `<li>${esc(x)}</li>`).join('');

    // Timeline + table highlight
    document.querySelectorAll('.tl-cell').forEach((c) => {
      const on = +c.dataset.i === i;
      c.classList.toggle('active', on);
      c.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#ftable-body tr').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.i === i));

    // Charts marker
    Object.values(state.charts).forEach((ch) => { try { ch.update('none'); } catch { /* noop */ } });
  }

  function startPlay() {
    if (!state.rows.length) return;
    stopPlay();
    state.playing = true;
    state.timer = setInterval(() => select((state.sel + 1) % state.rows.length), STEP_MS);
    updatePlayUI();
  }
  function stopPlay() {
    state.playing = false;
    clearInterval(state.timer);
    state.timer = null;
    updatePlayUI();
  }
  function updatePlayUI() {
    const b = $('#play-btn');
    b.innerHTML = icon(state.playing ? 'i-pause' : 'i-play');
    b.setAttribute('aria-label', state.playing ? 'Pause live replay' : 'Start live replay');
    b.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    const tag = $('#live-tag');
    tag.classList.toggle('on', state.playing);
    tag.lastChild.textContent = state.playing ? 'Live replay' : 'Paused';
  }

  /* ---------- charts ---------- */
  let hatch = null;
  function hatchPattern(ctx) {
    if (hatch) return hatch;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(203, 213, 225, 0.16)';
    x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(0, 8); x.lineTo(8, 0); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
    hatch = ctx.createPattern(c, 'repeat');
    return hatch;
  }
  function bandX(chart, i) {
    const x = chart.scales.x;
    const n = state.rows.length;
    const p = x.getPixelForValue(i);
    const step = n > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) : chart.chartArea.right - chart.chartArea.left;
    return [Math.max(chart.chartArea.left, p - step / 2), Math.min(chart.chartArea.right, p + step / 2)];
  }

  const bandsPlugin = {
    id: 'gpBands',
    beforeDatasetsDraw(chart, _args, opts) {
      if (!state.rows.length || !chart.scales.x) return;
      const { ctx, chartArea: { top, bottom } } = chart;
      ctx.save();
      if (opts.storage) {
        ctx.fillStyle = 'rgba(45, 212, 191, 0.075)';
        state.rows.forEach((r, i) => { if (isStorage(r)) { const [l, rr] = bandX(chart, i); ctx.fillRect(l, top, rr - l, bottom - top); } });
      }
      if (opts.window) {
        const idx = state.rows.map((r, i) => (inWindow(r.timestamp) ? i : -1)).filter((i) => i >= 0);
        if (idx.length) {
          const [l] = bandX(chart, idx[0]);
          const [, rr] = bandX(chart, idx[idx.length - 1]);
          ctx.fillStyle = hatchPattern(ctx);
          ctx.fillRect(l, top, rr - l, bottom - top);
          ctx.strokeStyle = 'rgba(203, 213, 225, 0.22)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(l + 0.5, top); ctx.lineTo(l + 0.5, bottom); ctx.moveTo(rr - 0.5, top); ctx.lineTo(rr - 0.5, bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(203, 213, 225, 0.7)';
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('18–22 WINDOW', (l + rr) / 2, top + 12);
        }
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart, _args, opts) {
      if (!state.rows.length || !chart.scales.x) return;
      const { ctx, chartArea: { top, bottom, right } } = chart;
      ctx.save();
      if (opts.thresholds && chart.scales.y) {
        const y = chart.scales.y;
        ctx.font = '600 10.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        [[RULE.storage, C.teal, '160 kW STORAGE'], [RULE.overload, C.redSoft, '200 kW OVERLOAD']].forEach(([v, col, txt]) => {
          const py = y.getPixelForValue(v);
          if (py < top || py > bottom) return;
          ctx.fillStyle = col;
          ctx.fillText(txt, right - 6, py - 5);
        });
      }
      if (opts.marker) {
        const x = chart.scales.x.getPixelForValue(state.sel);
        ctx.strokeStyle = 'rgba(230, 237, 243, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      }
      ctx.restore();
    },
  };

  function baseScales(yOpts = {}) {
    return {
      x: {
        offset: true,
        grid: { color: C.grid, drawTicks: false },
        border: { color: 'rgba(148,163,184,0.2)' },
        ticks: { color: C.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 10, padding: 6, font: { family: 'JetBrains Mono', size: 10.5 } },
      },
      y: {
        grid: { color: C.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: C.muted, padding: 8, font: { family: 'JetBrains Mono', size: 10.5 } },
        ...yOpts,
      },
    };
  }
  const tooltipBase = {
    backgroundColor: '#0F151D', borderColor: 'rgba(148,163,184,0.3)', borderWidth: 1, padding: 10,
    titleFont: { family: 'JetBrains Mono', weight: '700' }, bodyFont: { family: 'Inter' },
    titleColor: C.text, bodyColor: '#B8C4D2', displayColors: true, boxPadding: 4,
  };

  function renderCharts() {
    if (typeof window.Chart === 'undefined') {
      ['#chart-load', '#chart-soc', '#chart-temp'].forEach((s) => {
        const box = $(s).parentElement;
        if (!box.querySelector('.chart-fallback')) box.insertAdjacentHTML('beforeend', '<div class="chart-fallback">Chart library could not load. The timeline, KPIs and table below still show the full forecast.</div>');
      });
      return;
    }
    const Chart = window.Chart;
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = C.muted;
    Chart.defaults.animation.duration = 450;

    const labels = state.rows.map((r) => hourLabel(r.timestamp));
    const demand = state.rows.map((r) => num(r.predicted_demand_kw));
    const peak = Math.max(...demand.filter(Number.isFinite), 0);
    const yMax = Math.ceil(Math.max(230, peak * 1.12) / 10) * 10;
    const onClick = (_e, els, chart) => {
      if (els && els.length) { select(els[0].index, true); return; }
      const ev = _e; if (!ev || !chart) return;
      const v = chart.scales.x.getValueForPixel(ev.x);
      if (Number.isFinite(v)) select(Math.round(v), true);
    };

    // 1. Load curve
    const loadCfg = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Predicted demand (kW)', data: demand, borderWidth: 2.5, tension: 0.35, fill: 'origin',
            backgroundColor: (ctx) => {
              const { chart } = ctx; const { ctx: c, chartArea } = chart;
              if (!chartArea) return 'rgba(96,165,250,0.1)';
              const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, 'rgba(96,165,250,0.22)'); g.addColorStop(1, 'rgba(96,165,250,0)');
              return g;
            },
            segment: { borderColor: (ctx) => (isStorage(state.rows[ctx.p1DataIndex]) ? C.teal : C.blue) },
            borderColor: C.blue,
            pointRadius: (ctx) => (state.rows[ctx.dataIndex]?.overload_alert ? 6 : ctx.dataIndex === state.sel ? 5 : 2.5),
            pointHoverRadius: 7,
            pointBackgroundColor: (ctx) => { const r = state.rows[ctx.dataIndex]; return r?.overload_alert ? C.red : isStorage(r) ? C.teal : C.blue; },
            pointBorderColor: (ctx) => (state.rows[ctx.dataIndex]?.overload_alert ? 'rgba(239,68,68,0.35)' : '#0B0F14'),
            pointBorderWidth: (ctx) => (state.rows[ctx.dataIndex]?.overload_alert ? 5 : 1.5),
            order: 1,
          },
          { label: 'Storage threshold 160 kW', data: labels.map(() => RULE.storage), borderColor: C.teal, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, fill: false, order: 2 },
          { label: 'Overload limit 200 kW', data: labels.map(() => RULE.overload), borderColor: C.redSoft, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, fill: false, order: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick,
        scales: baseScales({ min: 0, max: yMax, title: { display: true, text: 'kW', color: C.muted, font: { size: 11 } } }),
        plugins: {
          legend: { display: false },
          gpBands: { storage: true, window: true, marker: true, thresholds: true },
          tooltip: {
            ...tooltipBase,
            filter: (item) => item.datasetIndex === 0,
            callbacks: {
              label: (item) => ` Demand ${fmt(item.raw)} kW`,
              afterLabel: (item) => {
                const r = state.rows[item.dataIndex];
                const lines = [` ${isStorage(r) ? 'Renewable storage' : 'Main grid'} · SoC ${fmt(r.battery_soc_pct)}%`];
                if (r.overload_alert) lines.push(' CRITICAL OVERLOAD');
                (r.reasons || []).slice(0, 3).forEach((x) => lines.push(` · ${x}`));
                return lines;
              },
            },
          },
        },
      },
      plugins: [bandsPlugin],
    };

    // 2. SoC + solar
    const socCfg = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Battery SoC (%)', data: state.rows.map((r) => num(r.battery_soc_pct)), borderColor: C.teal, backgroundColor: 'rgba(45,212,191,0.12)', fill: 'origin', tension: 0.3, borderWidth: 2.2, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'y', order: 1 },
          { type: 'line', label: 'Reserve 20%', data: labels.map(() => RULE.lowSoc), borderColor: C.amber, borderDash: [5, 5], borderWidth: 1.3, pointRadius: 0, pointHoverRadius: 0, fill: false, yAxisID: 'y', order: 2 },
          { type: 'bar', label: 'Solar generation (kW)', data: state.rows.map((r) => num(r.solar_generation_kw)), backgroundColor: C.solar, borderRadius: 3, yAxisID: 'y1', order: 3, barPercentage: 0.7, categoryPercentage: 0.9 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick,
        scales: {
          ...baseScales({ min: 0, max: 100, ticks: { color: C.muted, padding: 8, callback: (v) => `${v}%`, font: { family: 'JetBrains Mono', size: 10.5 } } }),
          y1: { position: 'right', min: 0, grid: { display: false }, border: { display: false }, ticks: { color: C.muted, padding: 6, callback: (v) => `${v} kW`, font: { family: 'JetBrains Mono', size: 10.5 } } },
        },
        plugins: {
          legend: { display: false },
          gpBands: { storage: true, window: false, marker: true },
          tooltip: { ...tooltipBase, filter: (i) => i.datasetIndex !== 1, callbacks: { label: (i) => ` ${i.dataset.label}: ${fmt(i.raw)}` } },
        },
      },
      plugins: [bandsPlugin],
    };

    // 3. Temp vs demand
    const pts = state.rows.map((r) => ({ x: num(r.ambient_temp_c), y: num(r.predicted_demand_kw) }));
    const tVals = pts.map((p) => p.x).filter(Number.isFinite);
    const tMin = tVals.length ? Math.floor(Math.min(...tVals) - 1) : 0;
    const tMax = tVals.length ? Math.ceil(Math.max(...tVals) + 1) : 40;
    const tempCfg = {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Hour', data: pts,
            pointRadius: (ctx) => (ctx.dataIndex === state.sel ? 7 : 4.5),
            pointHoverRadius: 7,
            pointBackgroundColor: (ctx) => { const r = state.rows[ctx.dataIndex]; return r?.overload_alert ? C.red : isStorage(r) ? 'rgba(45,212,191,0.85)' : 'rgba(96,165,250,0.85)'; },
            pointBorderColor: (ctx) => (ctx.dataIndex === state.sel ? '#fff' : 'rgba(11,15,20,0.9)'),
            pointBorderWidth: (ctx) => (ctx.dataIndex === state.sel ? 2 : 1),
          },
          { type: 'line', label: '160 kW', data: [{ x: tMin, y: RULE.storage }, { x: tMax, y: RULE.storage }], borderColor: C.teal, borderDash: [5, 5], borderWidth: 1.2, pointRadius: 0, pointHoverRadius: 0 },
          { type: 'line', label: '200 kW', data: [{ x: tMin, y: RULE.overload }, { x: tMax, y: RULE.overload }], borderColor: C.redSoft, borderDash: [5, 5], borderWidth: 1.2, pointRadius: 0, pointHoverRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        onClick: (_e, els) => { const el = els.find((x) => x.datasetIndex === 0); if (el) select(el.index, true); },
        scales: {
          x: { type: 'linear', min: tMin, max: tMax, grid: { color: C.grid, drawTicks: false }, border: { color: 'rgba(148,163,184,0.2)' }, ticks: { color: C.muted, padding: 6, callback: (v) => `${v}°`, font: { family: 'JetBrains Mono', size: 10.5 } }, title: { display: true, text: 'Ambient °C', color: C.muted, font: { size: 11 } } },
          y: { min: 0, max: yMax, grid: { color: C.grid, drawTicks: false }, border: { display: false }, ticks: { color: C.muted, padding: 8, font: { family: 'JetBrains Mono', size: 10.5 } }, title: { display: true, text: 'kW', color: C.muted, font: { size: 11 } } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipBase, filter: (i) => i.datasetIndex === 0, callbacks: { title: (items) => hourLabel(state.rows[items[0].dataIndex]?.timestamp), label: (i) => ` ${fmt(i.raw.x)} °C → ${fmt(i.raw.y)} kW` } },
        },
      },
    };

    const make = (key, sel, cfg) => {
      const existing = state.charts[key];
      if (existing) existing.destroy();
      state.charts[key] = new Chart($(sel), cfg);
    };
    try {
      make('load', '#chart-load', loadCfg);
      make('soc', '#chart-soc', socCfg);
      make('temp', '#chart-temp', tempCfg);
    } catch (e) {
      console.error(e);
      toast(`Chart render error: ${e.message}`);
    }
  }

  /* ---------- CSV export / template ---------- */
  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportResults() {
    if (!state.rows.length) { toast('Run a forecast before exporting', 'warn'); return; }
    const cols = ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2', 'solar_generation_kw', 'predicted_demand_kw', 'grid_mode', 'battery_soc_pct', 'overload_alert', 'reasons'];
    const lines = [cols.join(',')].concat(state.rows.map((r) => cols.map((c) => csvCell(c === 'reasons' ? (r.reasons || []).join('; ') : r[c])).join(',')));
    const d = dateLabel(state.rows[0].timestamp) || 'forecast';
    download(`gridpilot_forecast_${d}.csv`, lines.join('\n') + '\n');
    toast('Forecast exported as CSV', 'ok', 2500);
  }
  function downloadTemplate() {
    let rows = state.sample;
    if (!rows.length) {
      const base = new Date(); base.setHours(0, 0, 0, 0);
      rows = Array.from({ length: 24 }, (_, h) => ({ timestamp: fmtTs(new Date(base.getTime() + h * 3600000)), ambient_temp_c: '', humidity_pct: '', solar_irradiance_wm2: '' }));
    }
    const lines = [COLS.join(',')].concat(rows.map((r) => COLS.map((c) => csvCell(r[c])).join(',')));
    download('gridpilot_template.csv', lines.join('\n') + '\n');
  }

  /* ---------- events ---------- */
  function bind() {
    $('#play-btn').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
    $('#hour-range').addEventListener('input', (e) => select(+e.target.value, true));

    const tl = $('#timeline');
    tl.addEventListener('click', (e) => { const c = e.target.closest('.tl-cell'); if (c) { select(+c.dataset.i, true); showTip(c); } });
    tl.addEventListener('mouseover', (e) => { const c = e.target.closest('.tl-cell'); if (c) showTip(c); });
    tl.addEventListener('mouseleave', hideTip);
    tl.addEventListener('focusin', (e) => { const c = e.target.closest('.tl-cell'); if (c) showTip(c); });
    tl.addEventListener('focusout', hideTip);
    tl.addEventListener('keydown', (e) => {
      const c = e.target.closest('.tl-cell'); if (!c) return;
      const i = +c.dataset.i;
      let n = null;
      if (e.key === 'ArrowRight') n = i + 1; else if (e.key === 'ArrowLeft') n = i - 1;
      if (n !== null && n >= 0 && n < state.rows.length) { e.preventDefault(); select(n, true); tl.children[n].focus(); }
    });
    window.addEventListener('scroll', hideTip, { passive: true });

    $('#banners').addEventListener('click', (e) => {
      const d = e.target.closest('[data-dismiss]');
      if (d) { state.dismissed.add(d.dataset.dismiss); renderBanners(); return; }
      const j = e.target.closest('[data-jump]');
      if (j) { select(+j.dataset.jump, true); $('.strip').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });

    const sig = $('#signals');
    const sigGo = (e) => { const li = e.target.closest('li[data-i]'); if (li && +li.dataset.i >= 0) select(+li.dataset.i, true); };
    sig.addEventListener('click', sigGo);
    sig.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sigGo(e); } });

    $('#ftable-body').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) select(+tr.dataset.i, true); });
    $('#btn-export').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exportResults(); });

    // tabs
    const tabs = [$('#tab-upload'), $('#tab-manual')];
    const panels = [$('#panel-upload'), $('#panel-manual')];
    const setTab = (k) => {
      tabs.forEach((t, i) => { const on = i === k; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; panels[i].hidden = !on; });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => setTab(i));
      t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const k = (i + 1) % 2; setTab(k); tabs[k].focus(); } });
    });

    // dropzone
    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('drag')));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); const f = e.dataTransfer?.files?.[0]; if (f) runCsv(f); });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } });
    $('#file-input').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) runCsv(f); });
    $('#btn-template').addEventListener('click', downloadTemplate);

    // manual
    $('#manual-body').addEventListener('click', (e) => { const b = e.target.closest('.row-del'); if (b) { b.closest('tr').remove(); updateManualCount(); } });
    $('#btn-add').addEventListener('click', addHour);
    $('#btn-clear').addEventListener('click', () => { $('#manual-body').innerHTML = ''; updateManualCount(); toast('Manual table cleared. Add hours or load the sample.', 'ok', 2500); });
    $('#btn-run').addEventListener('click', () => runForecast(readManual(), 'manual entry'));
    $('#btn-sample').addEventListener('click', () => { setTab(1); loadSample(true); });

    document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) { stopPlay(); state.resume = true; } else if (!document.hidden && state.resume) { state.resume = false; startPlay(); } });
  }

  /* ---------- boot ---------- */
  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    bind();
    updatePlayUI();
    loadHealth();
    setInterval(loadHealth, 30000);
    loadLogs();
    setInterval(loadLogs, 10000);
    await loadSample(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
