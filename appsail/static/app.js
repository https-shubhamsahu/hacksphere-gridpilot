/* GridPilot dashboard. Team QUANTIX, HackSphere 3.0.
   Plain ES2017, no dependencies. Charts come from charts.js (window.GPCharts) when present. */
(function () {
  'use strict';

  var API = { health: 'api/health', sample: 'api/sample', forecast: 'api/forecast', csv: 'api/forecast/csv', logs: 'api/logs' };
  var RULE = { storage: 160, overload: 200, winStart: 18, winEnd: 22, reserve: 20 };
  var BATTERY = { capacity_kwh: 500, initial_soc_pct: 80 };
  var COLS = ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2'];
  var COL_NAMES = { timestamp: 'timestamp', ambient_temp_c: 'temperature', humidity_pct: 'humidity', solar_irradiance_wm2: 'irradiance' };
  var LIMITS = { ambient_temp_c: [-30, 60, 'Temperature', '°C'], humidity_pct: [0, 100, 'Humidity', '%'], solar_irradiance_wm2: [0, 1400, 'Irradiance', 'W/m²'] };
  var EVENT_WORDS = { SWITCH_TO_STORAGE: 'Switch to battery storage', SWITCH_TO_GRID: 'Switch to main grid', OVERLOAD_ALERT: 'Overload alert' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STEP_MS = 1500, LOG_MS = 10000, HEALTH_MS = 30000;
  var X_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  var state = {
    rows: [], summary: null, signals: [], cleaning: null, source: null, label: '', generatedAt: null,
    sel: 0, playing: false, timer: null, health: null, sample: [], charts: {}, dismissed: {},
    busy: false, tab: 0, file: null, logTimer: null, healthTimer: null, chartWidth: 0
  };
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  /* ---------- helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { return v === null || v === undefined || v === '' ? NaN : Number(v); }
  function fmt(v, d) { var n = num(v); return isFinite(n) ? n.toFixed(d == null ? 1 : d) : '–'; }
  function fmtInt(v) { var n = num(v); return isFinite(n) ? Math.round(n).toLocaleString('en-IN') : '–'; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function parseTs(ts) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(ts || '').trim());
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d;
  }
  function fmtTs(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function hourLabel(ts) { var m = /[ T](\d{1,2}):(\d{2})/.exec(String(ts || '')); return m ? pad(m[1]) + ':' + m[2] : String(ts || '–'); }
  function dayLabel(ts) { var m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(ts || '')); return m ? (+m[2]) + ' ' + MONTHS[+m[1] - 1] : ''; }
  function stamp(ts) { return (dayLabel(ts) + ' ' + hourLabel(ts)).trim(); }
  function isStorage(r) { return r && r.grid_mode === 'RENEWABLE_STORAGE'; }
  var istFmt = (function () {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
    catch (e) { return null; }
  })();
  function ist(d, withSeconds) {
    var s = istFmt ? istFmt.format(d) : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return withSeconds ? s : s.slice(0, 5);
  }
  function indexOfTs(ts) {
    for (var i = 0; i < state.rows.length; i++) if (state.rows[i].timestamp === ts) return i;
    return -1;
  }
  function modeHTML(r) {
    return isStorage(r)
      ? '<span class="mark mark-storage" aria-hidden="true"></span>Battery storage'
      : '<span class="mark mark-grid" aria-hidden="true"></span>Main grid';
  }

  function fetchJSON(url, opts, timeoutMs) {
    opts = opts || {};
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000) : null;
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers: headers, signal: ctrl ? ctrl.signal : undefined }))
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
          if (!res.ok) {
            var msg = data && data.error ? data.error : 'HTTP ' + res.status;
            var err = new Error(msg); err.data = data; throw err;
          }
          if (data === null) throw new Error('The server sent an empty or invalid response');
          return data;
        });
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('The server took too long to respond');
        if (e instanceof TypeError) throw new Error('Cannot reach the server');
        throw e;
      })
      .finally(function () { if (t) clearTimeout(t); });
  }

  /* ---------- clock + health ---------- */
  function tickClock() {
    var d = new Date();
    var el = $('#clock');
    el.textContent = ist(d, false);
    el.setAttribute('datetime', d.toISOString());
  }
  function loadHealth() {
    return fetchJSON(API.health, {}, 15000).then(function (h) {
      state.health = h; renderHealth();
    }).catch(function () {
      state.health = null; renderHealth(true);
    });
  }
  function sourceLabel(src) { return src === 'quickml' ? 'QuickML model' : 'local model'; }
  function renderHealth(offline) {
    var dot = $('#api-dot'), text = $('#api-text');
    if (offline || !state.health) {
      dot.className = 'dot dot-err';
      text.textContent = 'API offline';
      return;
    }
    var h = state.health;
    var ok = h.status === 'ok';
    dot.className = 'dot ' + (ok ? 'dot-ok' : 'dot-err');
    var src = state.source || (h.quickml_configured ? 'quickml' : 'local');
    var parts = [ok ? 'API online' : 'API ' + (h.status || 'degraded'), sourceLabel(src)];
    if (isFinite(num(h.validation_rmse))) parts.push('RMSE ' + fmt(h.validation_rmse, 2) + ' kW');
    text.textContent = parts.join(' · ');
    $('#api-status').title = 'Model ' + (h.model || '?') + (h.model_version ? ' ' + h.model_version : '') + ', QuickML ' + (h.quickml_configured ? 'configured' : 'not configured');
  }

  /* ---------- system log ---------- */
  function loadLogs() {
    return fetchJSON(API.logs, {}, 15000).then(function (res) {
      var events = Array.isArray(res.events) ? res.events.slice(-100).reverse() : [];
      var body = $('#log-body');
      if (!events.length) body.innerHTML = '<tr><td colspan="3" class="empty">No events logged yet.</td></tr>';
      else {
        body.innerHTML = events.map(function (ev) {
          var lvl = ['INFO', 'WARN', 'ALERT'].indexOf(ev.level) >= 0 ? ev.level : 'INFO';
          var d = new Date(ev.time);
          var t = isNaN(d.getTime()) ? esc(ev.time) : ist(d, true);
          return '<tr><td class="time">' + t + '</td><td><span class="lvl lvl-' + lvl + '">' + lvl + '</span></td><td>' + esc(ev.message) + '</td></tr>';
        }).join('');
      }
      $('#log-updated').textContent = 'Updated ' + ist(new Date(), true) + ' · ' + plural(events.length, 'event', 'events');
    }).catch(function () {
      $('#log-updated').textContent = 'Log unavailable, retrying in 10 s';
    });
  }
  function startPolling() {
    stopPolling();
    state.logTimer = setInterval(loadLogs, LOG_MS);
    state.healthTimer = setInterval(loadHealth, HEALTH_MS);
  }
  function stopPolling() {
    clearInterval(state.logTimer); clearInterval(state.healthTimer);
    state.logTimer = state.healthTimer = null;
  }

  /* ---------- forecast run ---------- */
  function setBusy(on, message) {
    state.busy = on;
    var btn = $('#btn-run');
    btn.setAttribute('aria-disabled', on ? 'true' : 'false');
    btn.textContent = on ? 'Running forecast…' : 'Run forecast';
    if (message !== undefined) setRunStatus(message);
  }
  function setRunStatus(msg, isError) {
    var el = $('#run-status');
    el.className = 'run-status' + (isError ? ' is-error' : '');
    el.innerHTML = msg || '';
  }

  function postForecast(rows) {
    return fetchJSON(API.forecast, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: rows, battery: BATTERY })
    });
  }
  function postCsv(file) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('capacity_kwh', String(BATTERY.capacity_kwh));
    fd.append('initial_soc_pct', String(BATTERY.initial_soc_pct));
    return fetchJSON(API.csv, { method: 'POST', body: fd });
  }

  function run(promiseFn, label, fromInput) {
    if (state.busy) return Promise.resolve();
    setBusy(true, 'Running forecast for ' + esc(label) + '…');
    return promiseFn().then(function (res) {
      applyResult(res, label);
      var n = state.rows.length;
      setRunStatus(fromInput ? 'Forecast updated: ' + plural(n, 'hour', 'hours') + ' from ' + esc(label) + '. <a href="#summary">Go to summary</a>' : '');
    }).catch(function (e) {
      if (e && e.data && e.data.cleaning) { state.cleaning = e.data.cleaning; state.label = label; renderCheck(); }
      setRunStatus('Forecast failed: ' + esc(e.message) + '. The previous forecast is still shown.', true);
      if (!state.rows.length) showLoadError(e.message);
    }).then(function () {
      setBusy(false);
      loadLogs();
    });
  }

  function applyResult(res, label) {
    var rows = res && Array.isArray(res.rows) ? res.rows : [];
    if (!rows.length) throw new Error('The forecast returned no rows');
    stopPlay();
    state.rows = rows;
    state.summary = res.summary || {};
    state.signals = Array.isArray(res.signals) ? res.signals : [];
    state.cleaning = res.cleaning || null;
    state.source = res.model_source || null;
    state.label = label;
    state.generatedAt = new Date();
    state.dismissed = {};
    var peak = indexOfTs(state.summary.peak_hour);
    state.sel = peak >= 0 ? peak : 0;
    renderAll();
  }

  /* ---------- rendering ---------- */
  function renderAll() {
    renderHealth(!state.health);
    renderSummary();
    renderNotices();
    renderStrip();
    renderCharts();
    renderFigures();
    renderSignals();
    renderTable();
    renderCheck();
    select(state.sel, { silent: true });
  }

  function headline() {
    var rows = state.rows, s = state.summary, n = rows.length;
    var st = s.storage_hours | 0, gr = s.grid_hours | 0;
    var lead = n === 1 ? 'Next hour: ' : 'Next ' + n + ' hours: ';
    var modes;
    if (st && gr) modes = 'battery storage for ' + st + ' h, main grid for ' + gr + ' h.';
    else if (st) modes = 'battery storage for all ' + st + ' h.';
    else modes = 'main grid for all ' + gr + ' h.';
    return lead + modes + ' Peak ' + fmtInt(s.peak_demand_kw) + ' kW at ' + hourLabel(s.peak_hour) + '.';
  }
  function renderSummary() {
    var h = $('#headline');
    h.classList.remove('is-loading');
    h.textContent = headline();
    var first = state.rows[0].timestamp, last = state.rows[state.rows.length - 1].timestamp;
    var parts = [
      'Forecast for ' + stamp(first) + ' – ' + stamp(last),
      'generated ' + ist(state.generatedAt, false) + ' IST',
      sourceLabel(state.source),
      'input: ' + state.label
    ];
    $('#run-meta').textContent = parts.join(' · ');
    document.title = 'GridPilot · Peak ' + fmtInt(state.summary.peak_demand_kw) + ' kW at ' + hourLabel(state.summary.peak_hour);
  }

  function renderNotices() {
    var rows = state.rows, out = [];
    var olIdx = [];
    rows.forEach(function (r, i) { if (r.overload_alert) olIdx.push(i); });
    if (olIdx.length && !state.dismissed.overload) {
      var pk = olIdx.reduce(function (a, i) { return num(rows[i].predicted_demand_kw) > num(rows[a].predicted_demand_kw) ? i : a; }, olIdx[0]);
      var pr = rows[pk];
      var over = num(pr.predicted_demand_kw) - RULE.overload;
      out.push(noticeHTML('overload', 'notice-alert',
        'Overload in ' + olIdx.length + ' of ' + plural(rows.length, 'hour', 'hours'),
        'Demand reaches ' + fmt(pr.predicted_demand_kw) + ' kW at ' + hourLabel(pr.timestamp) + ', ' + fmt(over) +
        ' kW above the 200 kW limit. First overload hour: ' + hourLabel(rows[olIdx[0]].timestamp) + '.',
        pk, 'overload notice'));
    }
    var minSoc = Infinity, minI = -1, firstLow = -1;
    rows.forEach(function (r, i) {
      var v = num(r.battery_soc_pct);
      if (!isFinite(v)) return;
      if (v < minSoc) { minSoc = v; minI = i; }
      if (v < RULE.reserve && firstLow < 0) firstLow = i;
    });
    if (firstLow >= 0 && !state.dismissed.reserve) {
      out.push(noticeHTML('reserve', 'notice-warn',
        'Battery below the 20% reserve from ' + hourLabel(rows[firstLow].timestamp),
        'Charge falls to ' + fmt(minSoc, 0) + '% at ' + hourLabel(rows[minI].timestamp) + '. The main grid covers the shortfall while the battery is low.',
        firstLow, 'battery reserve notice'));
    }
    $('#notices').innerHTML = out.join('');
  }
  function noticeHTML(key, cls, title, body, idx, name) {
    var t = hourLabel(state.rows[idx].timestamp);
    return '<div class="notice ' + cls + '" data-key="' + key + '">' +
      '<div><p class="notice-title">' + esc(title) + '</p><p>' + esc(body) + '</p></div>' +
      '<div class="notice-actions">' +
      '<button type="button" class="btn-text" data-view="' + idx + '" aria-label="View hour ' + t + '">View hour</button>' +
      '<button type="button" class="btn-icon" data-dismiss="' + key + '" aria-label="Dismiss ' + name + '">' + X_ICON + '</button>' +
      '</div></div>';
  }

  function renderStrip() {
    var strip = $('#strip');
    strip.style.setProperty('--n', state.rows.length);
    strip.innerHTML = state.rows.map(function (r, i) {
      var label = hourLabel(r.timestamp) + ', ' + (isStorage(r) ? 'battery storage' : 'main grid') + ', ' + fmt(r.predicted_demand_kw) + ' kW' + (r.overload_alert ? ', overload' : '');
      return '<div class="cell ' + (isStorage(r) ? 'storage' : 'grid') + (r.overload_alert ? ' ol' : '') + '" role="option" id="cell-' + i + '" data-i="' + i + '" tabindex="-1" aria-selected="false" aria-label="' + esc(label) + '">' +
        '<span aria-hidden="true">' + hourLabel(r.timestamp).slice(0, 2) + '</span><span class="bar" aria-hidden="true"></span></div>';
    }).join('');
  }

  function destroyCharts() {
    Object.keys(state.charts).forEach(function (k) {
      try { if (state.charts[k] && state.charts[k].destroy) state.charts[k].destroy(); } catch (e) { /* ignore */ }
    });
    state.charts = {};
  }
  function mountChart(key, el, make) {
    el.innerHTML = '';
    if (!window.GPCharts) {
      el.innerHTML = '<p class="chart-na">Chart unavailable. The figures and tables on this page carry the same data.</p>';
      return;
    }
    try { state.charts[key] = make(window.GPCharts, el) || null; }
    catch (e) {
      if (window.console) console.warn('GridPilot chart "' + key + '" failed:', e);
      el.innerHTML = '<p class="chart-na">Chart unavailable. The figures and tables on this page carry the same data.</p>';
    }
  }
  function renderCharts() {
    destroyCharts();
    var rows = state.rows;
    if (!rows.length) return;
    mountChart('forecast', $('#chart-forecast'), function (G, el) {
      return G.forecast(el, rows, {
        onHover: function () { /* hover preview is drawn by the chart itself */ },
        onSelect: function (i) { if (typeof i === 'number' && i >= 0) { stopPlay(); select(i, { announce: true }); } }
      });
    });
    mountChart('battery', $('#chart-battery'), function (G, el) { return G.battery(el, rows); });
    mountChart('temperature', $('#chart-temp'), function (G, el) { return G.temperature(el, rows); });
    state.chartWidth = $('#chart-forecast').clientWidth;
    var fc = state.charts.forecast;
    if (fc && fc.setActive) { try { fc.setActive(state.sel); } catch (e) { /* ignore */ } }
  }

  function renderFigures() {
    var s = state.summary, rows = state.rows, n = rows.length;
    $('#f-peak').textContent = fmtInt(s.peak_demand_kw);
    $('#f-peak-sub').textContent = 'at ' + hourLabel(s.peak_hour) + ', ' + stamp(s.peak_hour).split(' ').slice(0, 2).join(' ');
    $('#f-energy').textContent = fmtInt(s.total_energy_kwh);
    $('#f-energy-sub').textContent = 'average ' + fmt(s.avg_demand_kw) + ' kW';
    $('#f-split').textContent = (s.storage_hours | 0) + ' / ' + (s.grid_hours | 0);
    $('#f-split-bar').style.width = (n ? Math.round(100 * (s.storage_hours | 0) / n) : 0) + '%';
    $('#f-split-sub').textContent = 'battery storage / main grid';
    $('#f-switch').textContent = String(s.transitions | 0);
    $('#f-over').textContent = String(s.overload_hours | 0);
    var minSoc = num(s.min_soc_pct);
    $('#f-soc').textContent = fmt(minSoc, 0);
    var low = isFinite(minSoc) && minSoc < RULE.reserve;
    $('#fig-soc').classList.toggle('is-low', low);
    var at = -1;
    rows.forEach(function (r, i) { if (at < 0 && num(r.battery_soc_pct) === minSoc) at = i; });
    $('#f-soc-sub').textContent = (low ? 'below the 20% reserve' : '500 kWh bank') + (at >= 0 ? ', ' + hourLabel(rows[at].timestamp) : '');
    $('#table-count').textContent = String(n);
  }

  function renderSignals() {
    var body = $('#signals-body');
    var sig = state.signals;
    $('#signals-count').textContent = plural(sig.length, 'event', 'events');
    if (!sig.length) { body.innerHTML = '<tr><td colspan="3" class="empty">No dispatch events in this forecast.</td></tr>'; return; }
    body.innerHTML = sig.map(function (s) {
      var i = indexOfTs(s.timestamp);
      var ev = s.event;
      var mark = ev === 'OVERLOAD_ALERT' ? 'mark-overload' : ev === 'SWITCH_TO_STORAGE' ? 'mark-storage' : 'mark-grid';
      var time = i >= 0
        ? '<button type="button" class="btn-time" data-view="' + i + '" aria-label="View hour ' + stamp(s.timestamp) + '">' + esc(stamp(s.timestamp)) + '</button>'
        : esc(stamp(s.timestamp));
      return '<tr data-i="' + i + '"><td class="time">' + time + '</td><td><span class="ev' + (ev === 'OVERLOAD_ALERT' ? ' ev-alert' : '') + '"><span class="mark ' + mark + '" aria-hidden="true"></span>' +
        esc(EVENT_WORDS[ev] || ev) + '</span></td><td>' + esc(cap(s.detail)) + '</td></tr>';
    }).join('');
  }

  function renderTable() {
    $('#table-body').innerHTML = state.rows.map(function (r, i) {
      return '<tr data-i="' + i + '">' +
        '<td class="time"><button type="button" class="btn-time" data-view="' + i + '" aria-label="View hour ' + stamp(r.timestamp) + '">' + esc(stamp(r.timestamp)) + '</button></td>' +
        '<td><span class="mode-cell">' + modeHTML(r) + '</span></td>' +
        '<td class="num">' + fmt(r.predicted_demand_kw) + '</td>' +
        '<td>' + (r.overload_alert ? '<span class="yes"><span class="mark mark-overload" aria-hidden="true"></span>Yes</span>' : 'No') + '</td>' +
        '<td class="num">' + fmt(r.battery_soc_pct, 0) + '</td>' +
        '<td class="num">' + fmt(r.solar_generation_kw) + '</td>' +
        '<td class="num">' + fmt(r.ambient_temp_c) + '</td>' +
        '<td class="reasons-cell">' + esc((r.reasons || []).map(cap).join('; ')) + '</td></tr>';
    }).join('');
  }

  function countMap(obj) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return '0';
    return keys.map(function (k) { return (COL_NAMES[k] || k) + ' ' + obj[k]; }).join(', ');
  }
  function renderCheck() {
    var c = state.cleaning, el = $('#check-body');
    if (!c) { el.innerHTML = '<p class="muted">Shown after each forecast run.</p>'; return; }
    var warnings = Array.isArray(c.warnings) ? c.warnings : [];
    el.innerHTML =
      '<p class="check-src">Input: ' + esc(state.label || 'unknown') + '</p>' +
      '<dl class="check-list">' +
      '<div><dt>Rows received</dt><dd>' + esc(c.rows_in) + '</dd></div>' +
      '<div><dt>Rows used</dt><dd>' + esc(c.rows_out) + '</dd></div>' +
      '<div><dt>Dropped</dt><dd>' + esc(c.dropped) + '</dd></div>' +
      '<div><dt>Imputed</dt><dd>' + esc(countMap(c.imputed)) + '</dd></div>' +
      '<div><dt>Clipped</dt><dd>' + esc(countMap(c.clipped)) + '</dd></div>' +
      '</dl>' +
      (warnings.length
        ? '<h4 class="sr-only">Warnings</h4><ul class="check-warn">' + warnings.map(function (w) { return '<li>' + esc(cap(w)) + '</li>'; }).join('') + '</ul>'
        : '<p class="check-src">No problems found in the input.</p>');
  }

  /* ---------- selection (single source of truth) ---------- */
  function select(i, opts) {
    opts = opts || {};
    var rows = state.rows;
    if (!rows.length) return;
    i = Math.max(0, Math.min(rows.length - 1, i | 0));
    state.sel = i;
    var r = rows[i];

    $('#insp-time').textContent = hourLabel(r.timestamp);
    $('#insp-date').textContent = dayLabel(r.timestamp) + ' · hour ' + (i + 1) + ' of ' + rows.length;
    $('#insp-mode').innerHTML = modeHTML(r);
    $('#insp-demand').textContent = fmt(r.predicted_demand_kw);
    var d = num(r.predicted_demand_kw);
    var ol = $('#insp-overload');
    if (r.overload_alert) {
      ol.className = 'insp-overload is-over';
      ol.innerHTML = '<span class="mark mark-overload" aria-hidden="true"></span>Overload: ' + fmt(d - RULE.overload) + ' kW above the 200 kW limit';
    } else {
      ol.className = 'insp-overload';
      ol.textContent = 'No overload: ' + fmt(RULE.overload - d) + ' kW below the 200 kW limit';
    }
    var reasons = (r.reasons || []).length ? r.reasons : [isStorage(r) ? 'Storage rule met' : 'Demand at or below 160 kW and outside 18:00–22:00'];
    $('#insp-reasons').innerHTML = reasons.map(function (x) { return '<li>' + esc(cap(x)) + '</li>'; }).join('');
    var soc = num(r.battery_soc_pct);
    var socEl = $('#insp-soc');
    socEl.textContent = fmt(soc, 0) + ' %' + (soc < RULE.reserve ? ' (below reserve)' : '');
    socEl.classList.toggle('is-low', soc < RULE.reserve);
    $('#insp-solar').textContent = fmt(r.solar_generation_kw) + ' kW';
    $('#insp-temp').textContent = fmt(r.ambient_temp_c) + ' °C';
    $('#insp-hum').textContent = fmt(r.humidity_pct, 0) + ' %';
    $('#btn-prev').disabled = i === 0;
    $('#btn-next').disabled = i === rows.length - 1;

    $$('#strip .cell').forEach(function (c, k) {
      var on = k === i;
      c.setAttribute('aria-selected', on ? 'true' : 'false');
      c.tabIndex = on ? 0 : -1;
    });
    var cell = $('#cell-' + i);
    if (cell && !opts.silent) {
      var sc = cell.parentNode.parentNode;
      var left = cell.offsetLeft, right = left + cell.offsetWidth;
      if (left < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = left - sc.clientWidth / 2;
    }

    $$('#table-body tr, #signals-body tr').forEach(function (tr) {
      tr.classList.toggle('is-active', +tr.getAttribute('data-i') === i);
    });

    var fc = state.charts.forecast;
    if (fc && fc.setActive) { try { fc.setActive(i); } catch (e) { /* ignore */ } }

    if (opts.announce) {
      $('#insp-live').textContent = hourLabel(r.timestamp) + ': ' + (isStorage(r) ? 'battery storage' : 'main grid') + ', ' +
        fmt(d) + ' kW' + (r.overload_alert ? ', overload' : '');
    }
  }

  /* ---------- replay ---------- */
  function startPlay() {
    if (reduceMotion.matches || !state.rows.length) return;
    if (state.sel >= state.rows.length - 1) select(0);
    state.playing = true;
    state.timer = setInterval(function () {
      if (state.sel >= state.rows.length - 1) { stopPlay(); return; }
      select(state.sel + 1);
    }, STEP_MS);
    updatePlayUI();
  }
  function stopPlay() {
    clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    updatePlayUI();
  }
  function updatePlayUI() {
    var btn = $('#btn-play');
    btn.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    $('#play-label').textContent = state.playing ? 'Pause replay' : 'Replay day';
    btn.disabled = !!reduceMotion.matches;
    $('#play-note').textContent = reduceMotion.matches
      ? 'Replay is off because your system is set to reduce motion. Use Previous and Next instead.'
      : 'Steps through the day, one hour every 1.5 seconds.';
  }

  /* ---------- manual entry ---------- */
  function manualRowHTML(r, n) {
    r = r || {};
    function v(k) { return r[k] === null || r[k] === undefined ? '' : esc(r[k]); }
    return '<tr>' +
      '<td class="idx">' + n + '</td>' +
      '<td><input class="ts" type="text" data-col="timestamp" value="' + v('timestamp') + '" placeholder="YYYY-MM-DD HH:MM" aria-label="Row ' + n + ' timestamp" spellcheck="false" autocomplete="off"></td>' +
      '<td><input class="n" type="text" inputmode="decimal" data-col="ambient_temp_c" value="' + v('ambient_temp_c') + '" aria-label="Row ' + n + ' temperature, °C"></td>' +
      '<td><input class="n" type="text" inputmode="decimal" data-col="humidity_pct" value="' + v('humidity_pct') + '" aria-label="Row ' + n + ' humidity, %"></td>' +
      '<td><input class="n" type="text" inputmode="decimal" data-col="solar_irradiance_wm2" value="' + v('solar_irradiance_wm2') + '" aria-label="Row ' + n + ' irradiance, W/m²"></td>' +
      '<td><button type="button" class="btn-icon row-del" aria-label="Remove row ' + n + '">' + X_ICON + '</button></td>' +
      '</tr>';
  }
  function fillManual(rows) {
    $('#manual-body').innerHTML = rows.map(function (r, i) { return manualRowHTML(r, i + 1); }).join('');
    $('#manual-errors').innerHTML = '';
    updateManualCount();
  }
  function renumber() {
    $$('#manual-body tr').forEach(function (tr, i) {
      var n = i + 1;
      tr.querySelector('.idx').textContent = n;
      var ins = tr.querySelectorAll('input');
      ins[0].setAttribute('aria-label', 'Row ' + n + ' timestamp');
      ins[1].setAttribute('aria-label', 'Row ' + n + ' temperature, °C');
      ins[2].setAttribute('aria-label', 'Row ' + n + ' humidity, %');
      ins[3].setAttribute('aria-label', 'Row ' + n + ' irradiance, W/m²');
      tr.querySelector('.row-del').setAttribute('aria-label', 'Remove row ' + n);
    });
    updateManualCount();
  }
  function updateManualCount() {
    var n = $('#manual-body').children.length;
    $('#manual-count').textContent = plural(n, 'row', 'rows');
  }
  function checkInput(input) {
    var col = input.getAttribute('data-col');
    var s = input.value.trim();
    var msg = '';
    if (col === 'timestamp') {
      if (!s) msg = 'enter a timestamp as YYYY-MM-DD HH:MM';
      else if (!parseTs(s)) msg = 'timestamp “' + s + '” is not in the form YYYY-MM-DD HH:MM';
    } else if (s !== '') {
      var lim = LIMITS[col], v = Number(s);
      if (!isFinite(v)) msg = lim[2].toLowerCase() + ' “' + s + '” is not a number';
      else if (v < lim[0] || v > lim[1]) msg = lim[2].toLowerCase() + ' must be between ' + lim[0] + ' and ' + lim[1] + ' ' + lim[3];
    }
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return msg;
  }
  function validateManual() {
    var rows = [], errors = [];
    $$('#manual-body tr').forEach(function (tr, i) {
      var ins = tr.querySelectorAll('input');
      var empty = Array.prototype.every.call(ins, function (x) { return !x.value.trim(); });
      if (empty) { Array.prototype.forEach.call(ins, function (x) { x.removeAttribute('aria-invalid'); }); return; }
      var row = {};
      Array.prototype.forEach.call(ins, function (input) {
        var m = checkInput(input);
        if (m) errors.push({ row: i + 1, msg: m, input: input });
        var col = input.getAttribute('data-col'), s = input.value.trim();
        row[col] = col === 'timestamp' ? s : (s === '' ? null : Number(s));
      });
      rows.push(row);
    });
    renderManualErrors(errors);
    return { rows: rows, errors: errors };
  }
  function renderManualErrors(errors) {
    var el = $('#manual-errors');
    if (!errors.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<ul>' + errors.slice(0, 8).map(function (e) { return '<li><strong>Row ' + e.row + ':</strong> ' + esc(e.msg) + '.</li>'; }).join('') +
      (errors.length > 8 ? '<li>…and ' + (errors.length - 8) + ' more.</li>' : '') + '</ul>';
  }
  function addRow() {
    var body = $('#manual-body');
    var last = body.lastElementChild;
    var next = {};
    if (last) {
      var ins = last.querySelectorAll('input');
      var d = parseTs(ins[0].value);
      next = { timestamp: d ? fmtTs(new Date(d.getTime() + 3600000)) : '', ambient_temp_c: ins[1].value, humidity_pct: ins[2].value, solar_irradiance_wm2: ins[3].value };
    } else {
      var now = new Date(); now.setMinutes(0, 0, 0);
      next = { timestamp: fmtTs(now) };
    }
    body.insertAdjacentHTML('beforeend', manualRowHTML(next, body.children.length + 1));
    updateManualCount();
    var input = body.lastElementChild.querySelector('input');
    input.focus();
  }

  /* ---------- CSV helpers ---------- */
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvBlobUrl(text) { return URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); }
  function download(name, text) {
    var url = csvBlobUrl(text);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function exportResults() {
    if (!state.rows.length) { setRunStatus('Run a forecast before exporting.', true); return; }
    var cols = ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2', 'solar_generation_kw', 'predicted_demand_kw', 'grid_mode', 'battery_soc_pct', 'overload_alert', 'reasons'];
    var lines = [cols.join(',')].concat(state.rows.map(function (r) {
      return cols.map(function (c) { return csvCell(c === 'reasons' ? (r.reasons || []).join('; ') : r[c]); }).join(',');
    }));
    var d = (state.rows[0].timestamp || '').slice(0, 10) || 'forecast';
    download('gridpilot_forecast_' + d + '.csv', lines.join('\n') + '\n');
  }
  var templateUrl = null;
  function buildTemplate() {
    var rows = state.sample.length ? state.sample : (function () {
      var base = new Date(); base.setHours(0, 0, 0, 0);
      var out = [];
      for (var h = 0; h < 24; h++) out.push({ timestamp: fmtTs(new Date(base.getTime() + h * 3600000)), ambient_temp_c: '', humidity_pct: '', solar_irradiance_wm2: '' });
      return out;
    })();
    var text = [COLS.join(',')].concat(rows.map(function (r) { return COLS.map(function (c) { return csvCell(r[c]); }).join(','); })).join('\n') + '\n';
    if (templateUrl) URL.revokeObjectURL(templateUrl);
    templateUrl = csvBlobUrl(text);
    $('#tpl-link').href = templateUrl;
  }

  /* ---------- file input ---------- */
  function setFile(file) {
    var out = $('#file-name');
    if (!file) { state.file = null; out.className = 'dz-file'; out.textContent = 'No file chosen. One .csv file, up to 10 MB.'; return; }
    if (!/\.csv$/i.test(file.name)) {
      state.file = null; out.className = 'dz-file has-file';
      out.textContent = '“' + file.name + '” is not a .csv file. Choose a CSV file.';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      state.file = null; out.className = 'dz-file has-file';
      out.textContent = '“' + file.name + '” is larger than 10 MB.';
      return;
    }
    state.file = file;
    out.className = 'dz-file has-file';
    out.textContent = 'Selected: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB). Press Run forecast.';
  }

  /* ---------- tabs ---------- */
  var TABS = ['upload', 'manual', 'sample'];
  function setTab(k, focus) {
    state.tab = k;
    TABS.forEach(function (name, i) {
      var t = $('#tab-' + name), p = $('#panel-' + name), on = i === k;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    });
    $('#manual-errors').hidden = k !== 1;
    if (focus) $('#tab-' + TABS[k]).focus();
    setRunStatus('');
  }

  function onRunClick() {
    if (state.busy) return;
    if (state.tab === 0) {
      if (!state.file) { setRunStatus('Choose a CSV file first.', true); $('#btn-choose').focus(); return; }
      var f = state.file;
      run(function () { return postCsv(f); }, f.name, true);
    } else if (state.tab === 1) {
      var v = validateManual();
      if (!v.rows.length) { setRunStatus('Enter at least one hour of data.', true); return; }
      if (v.errors.length) {
        setRunStatus('Fix ' + plural(v.errors.length, 'entry', 'entries') + ' before running.', true);
        v.errors[0].input.focus();
        return;
      }
      run(function () { return postForecast(v.rows); }, 'manual entry', true);
    } else {
      if (!state.sample.length) {
        run(function () { return loadSample().then(function () { return postForecast(state.sample); }); }, 'sample day', true);
      } else {
        run(function () { return postForecast(state.sample); }, 'sample day', true);
      }
    }
  }

  /* ---------- load + errors ---------- */
  function loadSample() {
    return fetchJSON(API.sample).then(function (res) {
      var rows = Array.isArray(res.data) ? res.data : [];
      if (!rows.length) throw new Error('The sample endpoint returned no rows');
      state.sample = rows;
      fillManual(rows);
      buildTemplate();
      $('#sample-range').textContent = stamp(rows[0].timestamp) + ' to ' + stamp(rows[rows.length - 1].timestamp);
      return rows;
    });
  }
  function showLoadError(message) {
    var h = $('#headline');
    h.classList.add('is-loading');
    h.textContent = 'Forecast unavailable';
    $('#run-meta').textContent = 'The dashboard could not load a forecast.';
    $('#notices').innerHTML = '<div class="notice notice-error"><div><p class="notice-title">Could not load the forecast</p><p>' +
      esc(message) + '. Check that the API is running, then retry.</p></div><div class="notice-actions">' +
      '<button type="button" class="btn btn-secondary" id="btn-retry">Retry</button></div></div>';
    ['#signals-body', '#table-body'].forEach(function (s) {
      var cols = s === '#table-body' ? 8 : 3;
      $(s).innerHTML = '<tr><td colspan="' + cols + '" class="empty">No forecast loaded.</td></tr>';
    });
    ['#chart-forecast', '#chart-battery', '#chart-temp'].forEach(function (s) {
      $(s).innerHTML = '<p class="chart-na">No forecast loaded.</p>';
    });
  }
  function initialLoad() {
    var h = $('#headline');
    h.classList.add('is-loading');
    h.textContent = 'Loading forecast…';
    $('#run-meta').textContent = 'Fetching the sample day and running the model.';
    $('#notices').innerHTML = '';
    return loadSample()
      .then(function (rows) { return run(function () { return postForecast(rows); }, 'sample day', false); })
      .catch(function (e) { showLoadError(e.message); });
  }

  /* ---------- events ---------- */
  function bind() {
    // notices, signals and table share the data-view convention
    document.addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]');
      if (v) {
        stopPlay();
        select(+v.getAttribute('data-view'), { announce: true });
        if (v.closest('#notices')) {
          var target = window.matchMedia('(min-width: 1200px)').matches ? $('.forecast-grid') : $('#inspector');
          target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
          $('#inspector').focus({ preventScroll: true });
        }
        return;
      }
      var d = e.target.closest('[data-dismiss]');
      if (d) {
        state.dismissed[d.getAttribute('data-dismiss')] = true;
        renderNotices();
        var next = $('#notices [data-view]');
        if (next) next.focus(); else $('#headline').focus();
        return;
      }
      if (e.target.closest('#btn-retry')) initialLoad();
    });

    // hour strip: roving tabindex, arrow keys
    var strip = $('#strip');
    strip.addEventListener('click', function (e) {
      var c = e.target.closest('.cell'); if (!c) return;
      stopPlay(); select(+c.getAttribute('data-i'), { announce: true }); c.focus();
    });
    strip.addEventListener('keydown', function (e) {
      var n = state.rows.length, i = state.sel, k = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') k = i + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') k = i - 1;
      else if (e.key === 'Home') k = 0;
      else if (e.key === 'End') k = n - 1;
      if (k === null || k < 0 || k >= n) return;
      e.preventDefault(); stopPlay(); select(k, { announce: true });
      var c = $('#cell-' + k); if (c) c.focus();
    });

    $('#btn-prev').addEventListener('click', function () { stopPlay(); select(state.sel - 1, { announce: true }); });
    $('#btn-next').addEventListener('click', function () { stopPlay(); select(state.sel + 1, { announce: true }); });
    $('#btn-play').addEventListener('click', function () { if (state.playing) stopPlay(); else startPlay(); });
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', function () { if (reduceMotion.matches) stopPlay(); updatePlayUI(); });

    // tabs
    TABS.forEach(function (name, i) {
      var t = $('#tab-' + name);
      t.addEventListener('click', function () { setTab(i, false); });
      t.addEventListener('keydown', function (e) {
        var k = null;
        if (e.key === 'ArrowRight') k = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') k = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') k = 0;
        else if (e.key === 'End') k = TABS.length - 1;
        if (k === null) return;
        e.preventDefault(); setTab(k, true);
      });
    });

    // upload
    var dz = $('#dropzone'), input = $('#file-input');
    $('#btn-choose').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { setFile(input.files && input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); }); });
    ['dragleave', 'dragend', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.remove('is-over'); }); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(f);
    });
    $('#tpl-link').addEventListener('click', function (e) {
      if (!templateUrl) { e.preventDefault(); buildTemplate(); $('#tpl-link').click(); }
    });

    // manual entry
    var body = $('#manual-body');
    body.addEventListener('click', function (e) {
      var b = e.target.closest('.row-del'); if (!b) return;
      var tr = b.closest('tr'), next = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove(); renumber();
      if (next) next.querySelector('.row-del').focus(); else $('#btn-add').focus();
      if ($('#manual-errors').innerHTML) validateManual();
    });
    body.addEventListener('change', function (e) {
      if (e.target.matches('input')) { checkInput(e.target); if ($('#manual-errors').innerHTML || e.target.getAttribute('aria-invalid')) validateManual(); }
    });
    $('#btn-add').addEventListener('click', addRow);
    $('#btn-clear').addEventListener('click', function () { body.innerHTML = ''; $('#manual-errors').innerHTML = ''; updateManualCount(); $('#btn-add').focus(); setRunStatus('Table cleared. Add rows to enter your own hours.'); });
    $('#btn-reset').addEventListener('click', function () { fillManual(state.sample); setRunStatus('Table refilled with the sample day.'); });

    $('#btn-run').addEventListener('click', onRunClick);
    $('#btn-export').addEventListener('click', exportResults);

    // polling pauses while the tab is hidden
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopPolling(); if (state.playing) { stopPlay(); state.resume = true; } }
      else { loadLogs(); loadHealth(); startPolling(); if (state.resume) { state.resume = false; startPlay(); } }
    });

    // re-render charts when their width changes
    var resizeT = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () {
        var w = $('#chart-forecast').clientWidth;
        if (state.rows.length && Math.abs(w - state.chartWidth) > 8) renderCharts();
      }, 200);
    });
  }

  function boot() {
    tickClock();
    setInterval(tickClock, 15000);
    bind();
    updatePlayUI();
    buildTemplate();
    loadHealth();
    loadLogs();
    if (!document.hidden) startPolling();
    initialLoad();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
