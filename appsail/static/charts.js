/* GridPilot charts. Hand-set SVG in a Swiss / FT print style.
   No dependencies, no build step, ES2017.
   window.GPCharts = { forecast, battery, temperature }
   Flat colour only: no colour ramps, no drop effects, no animation except a
   150 ms fade on the active rule (off under prefers-reduced-motion). */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var SWITCH_KW = 160, OVERLOAD_KW = 200, RESERVE_PCT = 20;
  var PEAK_START = 18, PEAK_END = 22;      // evening peak window, inclusive (controller.py)
  var FS = 13;                              // label size, px
  var TOP = 26;                             // top row: units, peak-window label, readout
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------- tokens, text, markup helpers ---------- */

  function tokens() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) { var x = cs.getPropertyValue(name); return (x && x.trim()) || fb; }
    return {
      paper: v('--paper', '#FFFFFF'), tint: v('--paper-2', '#F4F4F2'),
      ink: v('--ink', '#111111'), ink2: v('--ink-2', '#3D3D3D'), ink3: v('--ink-3', '#6B6B6B'),
      rule: v('--rule', '#D6D6D2'), grid: v('--rule-2', '#EBEBE8'),
      accent: v('--accent', '#00754A'), alert: v('--alert', '#C62828'),
      warn: v('--warn', '#8A5A00'), bar: '#C9C9C5',
      sans: v('--sans', '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif')
    };
  }

  var ctx2d = null;
  function textW(s, size, weight, family) {
    if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d');
    ctx2d.font = (weight || 400) + ' ' + (size || FS) + 'px ' + family;
    return ctx2d.measureText(String(s)).width;
  }

  function r1(v) { return Math.round(v * 10) / 10; }
  function crisp(v) { return Math.round(v) + 0.5; }       // 1px lines on the pixel grid
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  function pad2(h) { return (h < 10 ? '0' : '') + h; }
  function fmt(v) { return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function el(tag, a, inner) {
    var s = '<' + tag;
    for (var k in a) if (a[k] != null) s += ' ' + k + '="' + esc(a[k]) + '"';
    return s + (inner == null ? '/>' : '>' + inner + '</' + tag + '>');
  }
  function line(x1, y1, x2, y2, stroke, w, dash) {
    return el('line', { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), stroke: stroke,
      'stroke-width': w || 1, 'stroke-dasharray': dash || null });
  }
  function rect(x, y, w, h, a) {
    a = a || {}; a.x = r1(x); a.y = r1(y); a.width = r1(Math.max(0, w)); a.height = r1(Math.max(0, h));
    return el('rect', a);
  }
  function dot(x, y, r, a) { a = a || {}; a.cx = r1(x); a.cy = r1(y); a.r = r; return el('circle', a); }
  // Text; `halo` knocks the label out of anything behind it with a paper-coloured stroke.
  function txt(x, y, s, o) {
    o = o || {};
    var a = { x: r1(x), y: r1(y), fill: o.fill, 'font-size': o.size || FS,
      'font-weight': o.weight || null, 'text-anchor': o.anchor || null };
    if (o.halo) { a.stroke = o.halo; a['stroke-width'] = 4; a['stroke-linejoin'] = 'round'; a['paint-order'] = 'stroke'; }
    return el('text', a, esc(s));
  }

  /* ---------- data ---------- */

  function parseTs(ts) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''));
    if (!m) return { key: '', day: '', hour: 0, hh: '--:--' };
    return { key: m[1] + m[2] + m[3], day: (+m[3]) + ' ' + MONTHS[+m[2] - 1], hour: +m[4], hh: m[4] + ':' + m[5] };
  }

  function prep(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (r) {
      r = r || {};
      return { t: parseTs(r.timestamp), kw: num(r.predicted_demand_kw), temp: num(r.ambient_temp_c),
        soc: num(r.battery_soc_pct), solar: num(r.solar_generation_kw),
        storage: r.grid_mode === 'RENEWABLE_STORAGE', over: !!r.overload_alert };
    });
  }

  function keep(a, f) { var o = []; a.forEach(function (x) { if (f(x)) o.push(x); }); return o; }
  function argmax(P, k) { var b = 0; P.forEach(function (p, i) { if (p[k] > P[b][k]) b = i; }); return b; }
  function extent(P, k) {
    return P.reduce(function (e, p) { return [Math.min(e[0], p[k]), Math.max(e[1], p[k])]; }, [Infinity, -Infinity]);
  }
  // Within 24 rows each clock hour is unique, so the date only matters for longer series.
  function when(P, i) { return (P.length > 24 ? P[i].t.day + ' ' : '') + P[i].t.hh; }

  // Round axis: ticks on 1/2/2.5/5 x 10^k, at most maxTicks intervals, ends snapped outward.
  function axis(lo, hi, maxTicks) {
    var span = (hi - lo) || 1, mag = Math.pow(10, Math.floor(Math.log10(span / maxTicks)));
    var mults = [1, 2, 2.5, 5, 10, 20, 25, 50], st = mag, a = lo, b = hi;
    for (var k = 0; k < mults.length; k++) {
      st = mults[k] * mag;
      a = Math.floor(lo / st + 1e-9) * st; b = Math.ceil(hi / st - 1e-9) * st;
      if ((b - a) / st <= maxTicks) break;
    }
    var ticks = [];
    for (var v = a; v <= b + st / 2; v += st) ticks.push(+v.toFixed(6));
    return { lo: a, hi: b, step: st, ticks: ticks };
  }
  // The domain stays as given; ticks are the finest 1/2/5 step that fits inside it.
  function ticksWithin(lo, hi, maxTicks) {
    var mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / maxTicks))), mults = [1, 2, 5, 10, 20, 50];
    for (var k = 0; k < mults.length; k++) {
      var st = mults[k] * mag, out = [];
      for (var v = Math.ceil(lo / st - 1e-9) * st; v <= hi + 1e-9; v += st) out.push(+v.toFixed(6));
      if (out.length <= maxTicks) return out;
    }
    return [lo, hi];
  }

  /* ---------- label placement: first candidate that clears the data ---------- */

  // Box around a 13px label with baseline b, anchored at x ('start' or 'end').
  function tbox(x, b, w, anchor) {
    var x0 = anchor === 'end' ? x - w : x;
    return { x0: x0, x1: x0 + w, y0: b - 11, y1: b + 3, x: x, b: b, anchor: anchor };
  }
  function hit(bx, obs) {
    return obs.some(function (o) { return bx.x0 < o.x1 && bx.x1 > o.x0 && bx.y0 < o.y1 && bx.y1 > o.y0; });
  }
  function ptObs(x, y, pad) { return { x0: x - pad, x1: x + pad, y0: y - pad, y1: y + pad }; }
  // Obstacles sampled every ~3px along a polyline [[x, y], ...].
  function polyObs(pts, pad) {
    var out = [];
    for (var k = 1; k < pts.length; k++) {
      var a = pts[k - 1], b = pts[k], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
      for (var j = 0; j <= n; j++) out.push(ptObs(a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n, pad));
    }
    return out;
  }
  function pick(cands, obs) {
    for (var i = 0; i < cands.length; i++) if (!hit(cands[i], obs)) return cands[i];
    return cands[0];
  }
  // Candidates sliding along [x0, x1], above (b = y - 5) then below (b = y + 15) the line;
  // ends are tried first. `texts` lists the label from longest to shortest.
  function slideCands(T, texts, y, x0, x1, weight) {
    var cands = [];
    texts.forEach(function (s) {
      var tw = textW(s, FS, weight, T.sans), span = Math.max(0, x1 - x0 - 4 - tw), xs = [x1, x0 + 4 + tw];
      for (var k = 1; k < 8; k++) xs.push(x1 - span * k / 8);
      xs.forEach(function (ex) {
        [y - 5, y + 15].forEach(function (b) { var c = tbox(ex, b, tw, 'end'); c.s = s; cands.push(c); });
      });
    });
    return cands;
  }

  /* ---------- shared mount: svg, resize, fonts, teardown ---------- */

  function injectStyle() {
    if (document.getElementById('gpc-style')) return;
    var s = document.createElement('style');
    s.id = 'gpc-style';
    s.textContent =
      '.gpc{display:block;overflow:visible;font-variant-numeric:tabular-nums lining-nums;' +
      '-webkit-tap-highlight-color:transparent;user-select:none}' +
      '.gpc:focus{outline:none}.gpc:focus-visible{outline:2px solid var(--focus,#1F5FBF);outline-offset:2px}' +
      '.gpc-active{transition:opacity 150ms linear}' +
      '@media (prefers-reduced-motion:reduce){.gpc-active{transition:none}}' +
      '.gpc-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;' +
      'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}';
    document.head.appendChild(s);
  }

  function mount(container, label, draw) {
    injectStyle();
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gpc');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.style.fontFamily = 'var(--sans, "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif)';
    var sr = document.createElement('div');
    sr.className = 'gpc-sr';
    container.appendChild(svg);
    container.appendChild(sr);

    var size = { w: 0, h: 0 }, timer = 0, dead = false, ro = null;

    function inner() {
      var cs = getComputedStyle(container);
      return {
        w: container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0),
        h: container.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
      };
    }
    function render() {
      if (dead) return;
      svg.setAttribute('height', '0');               // let the page decide the height
      var s = inner(), w = Math.max(1, Math.floor(s.w));
      var h = s.h > 0 ? Math.floor(s.h) : Math.round(clamp(w * 0.46, 240, 380));
      size = { w: w, h: h };
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      draw(svg, w, h, tokens());
    }
    function onResize() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var s = inner();
        if (Math.floor(s.w) !== size.w || Math.floor(s.h) !== size.h) render();
      }, 120);
    }
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(container); }
    else window.addEventListener('resize', onResize);
    // Text is measured, so redraw once the web font has arrived.
    if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(render);

    return {
      svg: svg, sr: sr, render: render,
      destroy: function () {
        dead = true;
        clearTimeout(timer);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
        if (svg.parentNode) svg.parentNode.removeChild(svg);
        if (sr.parentNode) sr.parentNode.removeChild(sr);
      }
    };
  }

  // Hour labels and date flags under a band (one slot per row) x axis.
  function hourAxis(T, P, left, step, ruleTop, ruleBottom, yHour, yDay, right) {
    var out = '', minGap = textW('00', FS, 400, T.sans) + 12, every = 24;
    [1, 3, 6, 12, 24].some(function (k) { if (k * step >= minGap) { every = k; return true; } return false; });
    P.forEach(function (p, i) {
      if (p.t.hour % every === 0) out += txt(left + (i + 0.5) * step, yHour, pad2(p.t.hour), { fill: T.ink3, anchor: 'middle' });
    });
    var lastEnd = -Infinity;
    P.forEach(function (p, i) {
      if (i > 0 && p.t.key === P[i - 1].t.key) return;
      var x = left + i * step, tx = i ? x + 4 : x, tw = textW(p.t.day, FS, 500, T.sans);
      if (i > 0) {   // day change: hairline through the panels, tick + label on the date row
        out += line(crisp(x), ruleTop, crisp(x), ruleBottom, T.rule, 1);
        out += line(crisp(x), yDay - 11, crisp(x), yDay + 2, T.ink3, 1);
      }
      if (tx >= lastEnd && tx + tw <= right) {
        out += txt(tx, yDay, p.t.day, { fill: T.ink2, weight: 500 });
        lastEnd = tx + tw + 10;
      }
    });
    return out;
  }

  // Tinted bands behind each run of peak-window hours. Returns markup + the first band.
  function peakBands(T, P, left, step, y0, y1) {
    var out = '', first = null, start = -1;
    for (var i = 0; i <= P.length; i++) {
      var inPeak = i < P.length && P[i].t.hour >= PEAK_START && P[i].t.hour <= PEAK_END;
      if (start >= 0 && !(inPeak && P[i].t.key === P[start].t.key)) {   // close the run
        var x = left + start * step, w = (i - start) * step;
        out += rect(x, y0, w, y1 - y0, { fill: T.tint });
        if (!first) first = { x: x, w: w };
        start = -1;
      }
      if (inPeak && start < 0) start = i;
    }
    return { svg: out, first: first };
  }

  // Dashed 160 / 200 kW lines. Lines go under the data; labels are placed where they
  // clear `obs` (right end preferred) and drawn last. Placed boxes join `obs`.
  function thresholds(T, y, x0, x1, obs) {
    var under = '', over = '';
    [[OVERLOAD_KW, 'overload', T.alert], [SWITCH_KW, 'switch', T.ink2]].forEach(function (d) {
      var yy = y(d[0]), c = pick(slideCands(T, [d[0] + ' kW ' + d[1], d[0] + ' kW'], yy, x0, x1, 500), obs);
      obs.push(c);
      under += line(x0, yy, x1, yy, d[2], 1.5, '6 4');
      over += txt(c.x, c.b, c.s, { fill: d[2], weight: 500, anchor: c.anchor, halo: T.paper });
    });
    return { under: under, over: over };
  }

  function emptyState(svg, T) {
    svg.innerHTML = txt(0, 20, 'No forecast data', { fill: T.ink3 });
  }

  /* ---------- 1. forecast: demand line + source strip ---------- */

  function forecast(container, rows, opts) {
    opts = opts || {};
    var P = prep(rows), n = P.length, peakI = n ? argmax(P, 'kw') : 0;
    var sel = null, hover = null, g = null;
    var m = mount(container, forecastSummary(P, peakI), draw), svg = m.svg;
    svg.setAttribute('tabindex', '0');
    svg.style.touchAction = 'pan-y';
    m.sr.innerHTML = forecastTable(P) + '<p aria-live="polite"></p>';
    var live = m.sr.querySelector('p');

    function draw(svg, w, h, T) {
      if (!n) { g = null; return emptyState(svg, T); }
      var maxKw = P[peakI].kw, ax = axis(0, Math.max(maxKw, OVERLOAD_KW), h < 260 ? 3 : 4);
      var labW = Math.max(textW(fmt(ax.hi), FS, 400, T.sans), textW('Source', FS, 500, T.sans));
      var left = Math.ceil(labW) + 10, pr = w - 2, step = (pr - left) / n;
      var letters = step >= 15, cellH = letters ? 18 : 12, gap = step >= 8 ? 2 : step >= 4 ? 1 : 0;
      // vertical layout, bottom up
      var yDay = h - 4, yHour = yDay - 17, stripBot = yHour - 15, stripTop = stripBot - cellH;
      var dotY = stripTop - 7, base = dotY - 12, gridTop = TOP + 22;
      var y = function (v) { return base - (v / ax.hi) * (base - gridTop); };
      var cx = function (i) { return left + (i + 0.5) * step; };
      var out = '';

      // peak window bands + label above the first one
      var bands = peakBands(T, P, left, step, TOP, base);
      out += bands.svg;
      if (bands.first) {
        var bl = 'peak window', full = PEAK_START + '–' + PEAK_END + ' h ' + bl;
        var lab = textW(full, FS, 400, T.sans) <= w - bands.first.x ? full : PEAK_START + '–' + PEAK_END + ' h peak';
        var lw = textW(lab, FS, 400, T.sans), lx = Math.min(bands.first.x, w - lw);
        out += '<g class="gpc-toprow" data-x0="' + r1(lx) + '" data-x1="' + r1(lx + lw) + '">' +
          txt(lx, 17, lab, { fill: T.ink3 }) + '</g>';
      }

      // gridlines, y labels, unit
      ax.ticks.forEach(function (t) {
        if (t > 0) out += line(left, crisp(y(t)), pr, crisp(y(t)), T.grid, 1);
        out += txt(left - 8, y(t) + 4.5, fmt(t), { fill: T.ink3, anchor: 'end' });
      });
      out += '<g class="gpc-toprow" data-x0="' + r1(left - 8 - textW('kW', FS, 400, T.sans)) + '" data-x1="' +
        r1(left - 8) + '">' + txt(left - 8, 17, 'kW', { fill: T.ink3, anchor: 'end' }) + '</g>';

      out += hourAxis(T, P, left, step, TOP, stripBot, yHour, yDay, w);
      out += line(left, crisp(base), pr, crisp(base), T.ink, 1);     // zero line

      // what labels must avoid: the demand line and its dots
      var pts = P.map(function (p, i) { return [cx(i), y(p.kw)]; }), rOver = clamp(step * 0.38, 3, 5);
      var obs = polyObs(pts, 4).concat(P.map(function (p, i) { return ptObs(pts[i][0], pts[i][1], rOver + 2); }));

      // peak annotation: short leader up and away from the point, label above the line
      var px = pts[peakI][0], py = pts[peakI][1], note = Math.round(maxKw) + ' kW at ' + when(P, peakI);
      var nw = textW(note, FS, 600, T.sans);
      var pc = pick(keep([tbox(px + 14, py - 9, nw, 'start'), tbox(px - 14, py - 9, nw, 'end')],
        function (c) { return c.x0 >= left && c.x1 <= pr; }).concat([tbox(pr, py - 9, nw, 'end')]), obs);
      var sx = pc.anchor === 'start' ? 1 : -1;
      obs.push(pc);
      var noteSvg = line(px + sx * 5, py - 5, px + sx * 11, py - 11, T.ink, 1) +
        txt(pc.x, pc.b, note, { fill: T.ink, weight: 600, anchor: pc.anchor, halo: T.paper });

      var th = thresholds(T, y, left, pr, obs);
      out += th.under;

      // demand line, hour dots, overload dots
      out += el('polyline', { points: pts.map(function (q) { return r1(q[0]) + ',' + r1(q[1]); }).join(' '),
        fill: 'none', stroke: T.ink, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      P.forEach(function (p, i) {
        if (p.over) out += dot(pts[i][0], pts[i][1], rOver, { fill: T.alert, stroke: T.paper, 'stroke-width': 1.5 });
        else if (step >= 10) out += dot(pts[i][0], pts[i][1], 2.5, { fill: T.ink });
      });
      out += th.over + noteSvg;

      // source strip: S = storage (filled), G = grid (outlined), red dot = overload
      out += txt(left - 8, stripTop + cellH / 2 + 4.5, 'Source', { fill: T.ink2, weight: 500, anchor: 'end' });
      P.forEach(function (p, i) {
        var x = left + i * step + gap / 2, cw = step - gap, mx = cx(i);
        if (p.storage) out += rect(x, stripTop, cw, cellH, { fill: T.accent });
        else {
          var sw = cw >= 6 ? 1.5 : 1;
          out += rect(x + sw / 2, stripTop + sw / 2, cw - sw, cellH - sw, { fill: T.paper, stroke: T.ink, 'stroke-width': sw });
        }
        if (letters) out += txt(mx, stripTop + cellH / 2 + 4, p.storage ? 'S' : 'G',
          { fill: p.storage ? T.paper : T.ink, size: 11, weight: 600, anchor: 'middle' });
        if (p.over) out += dot(mx, dotY, step >= 6 ? 2.5 : 1.5, { fill: T.alert });
      });

      out += '<g class="gpc-active" style="opacity:0"></g>';
      svg.innerHTML = out;
      g = { T: T, w: w, left: left, step: step, y: y, cx: cx, stripBot: stripBot,
        active: svg.querySelector('.gpc-active'), toprow: svg.querySelectorAll('.gpc-toprow') };
      drawActive();
    }

    // Active hour: vertical rule, ring on the point, one-line readout in the top row.
    function drawActive() {
      if (!g) return;
      var i = hover != null ? hover : sel, grp = g.active, T = g.T;
      // top-row labels (unit, peak window) step aside while the readout uses that row
      function showTop(x0, x1) {
        Array.prototype.forEach.call(g.toprow, function (n) {
          var clash = x0 != null && +n.getAttribute('data-x0') < x1 + 6 && +n.getAttribute('data-x1') > x0 - 6;
          n.style.visibility = clash ? 'hidden' : '';
        });
      }
      if (i == null) { grp.style.opacity = '0'; showTop(null); return; }
      var p = P[i], x = g.cx(i), py = g.y(p.kw), out = '';
      out += line(crisp(x), 4, crisp(x), g.stripBot + 3, T.ink, 1);
      out += p.over ? dot(x, py, 8, { fill: 'none', stroke: T.ink, 'stroke-width': 1.5 })
        : dot(x, py, 4.5, { fill: T.paper, stroke: T.ink, 'stroke-width': 2 });
      var parts = [[when(P, i), 600, T.ink], [Math.round(p.kw) + ' kW', 400, T.ink],
        [p.storage ? 'Storage' : 'Grid', 500, p.storage ? T.accent : T.ink]];
      if (p.over) parts.push(['overload', 500, T.alert]);
      var widths = parts.map(function (q) { return textW(q[0], FS, q[1], T.sans); });
      var total = widths.reduce(function (a, b) { return a + b; }, 0) + 10 * (parts.length - 1);
      var tx = x + 7 + total <= g.w ? x + 7 : Math.max(0, x - 7 - total);
      showTop(tx, tx + total);
      var spans = '', at = tx;
      parts.forEach(function (q, k) {
        spans += el('tspan', { x: r1(at), fill: q[2], 'font-weight': q[1] }, esc(q[0]));
        at += widths[k] + 10;
      });
      out += el('text', { y: 17, 'font-size': FS }, spans);
      grp.innerHTML = out;
      grp.style.opacity = '1';
    }

    function indexAt(e) {
      var b = svg.getBoundingClientRect();
      return clamp(Math.floor((e.clientX - b.left - g.left) / g.step), 0, n - 1);
    }
    function setHover(i) {
      if (i === hover) return;
      hover = i;
      drawActive();
      if (opts.onHover) opts.onHover(i);
    }
    function select(i, notify) {
      sel = i == null ? null : clamp(i | 0, 0, n - 1);
      drawActive();
      if (notify && sel != null && opts.onSelect) opts.onSelect(sel);
    }
    function onMove(e) { if (g) setHover(indexAt(e)); }
    function onLeave() { setHover(null); }
    function onClick(e) { if (g) select(indexAt(e), true); }
    function onKey(e) {
      if (!n) return;
      var cur = sel != null ? sel : hover != null ? hover : -1, next;
      if (e.key === 'ArrowRight') next = cur < 0 ? 0 : cur + 1;
      else if (e.key === 'ArrowLeft') next = cur < 0 ? n - 1 : cur - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      else return;
      e.preventDefault();
      hover = null;
      select(next, true);
      var p = P[sel];
      live.textContent = when(P, sel) + ', ' + Math.round(p.kw) + ' kilowatts, ' +
        (p.storage ? 'storage' : 'main grid') + (p.over ? ', overload' : '');
    }
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerdown', onMove);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('click', onClick);
    svg.addEventListener('keydown', onKey);
    m.render();

    return {
      setActive: function (i) { select(i, false); },
      destroy: function () {
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerdown', onMove);
        svg.removeEventListener('pointerleave', onLeave);
        svg.removeEventListener('click', onClick);
        svg.removeEventListener('keydown', onKey);
        m.destroy();
        g = null;
      }
    };
  }

  function forecastSummary(P, peakI) {
    if (!P.length) return 'Demand forecast: no data';
    var over = keep(P, function (p) { return p.over; }).length;
    var sto = keep(P, function (p) { return p.storage; }).length;
    return 'Demand forecast, ' + P.length + ' hours from ' + P[0].t.day + ' ' + P[0].t.hh +
      '. Peak ' + Math.round(P[peakI].kw) + ' kW at ' + when(P, peakI) + '. ' +
      over + ' overload hours at or above ' + OVERLOAD_KW + ' kW. Storage ' + sto + ' h, main grid ' +
      (P.length - sto) + ' h. Arrow keys step through hours.';
  }

  function forecastTable(P) {
    var body = P.map(function (p, i) {
      return '<tr><th scope="row">' + esc(when(P, i)) + '</th><td>' + fmt(r1(p.kw)) + '</td><td>' +
        (p.storage ? 'Storage' : 'Main grid') + '</td><td>' + (p.over ? 'Yes' : 'No') + '</td></tr>';
    }).join('');
    return '<table><caption>Hourly demand forecast</caption><thead><tr><th scope="col">Hour</th>' +
      '<th scope="col">Demand (kW)</th><th scope="col">Source</th><th scope="col">Overload</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>';
  }

  /* ---------- 2. battery charge + solar generation ---------- */

  function battery(container, rows) {
    var P = prep(rows), n = P.length;
    var label = 'Battery charge and solar generation by hour';
    if (n) {
      var se = extent(P, 'soc'), sp = argmax(P, 'solar');
      label += '. Battery between ' + fmt(se[0]) + '% and ' + fmt(se[1]) + '%. Solar peaks at ' +
        fmt(r1(P[sp].solar)) + ' kW at ' + when(P, sp) + '.';
    }
    var m = mount(container, label, function (svg, w, h, T) {
      if (!n) return emptyState(svg, T);
      var sStep = axis(0, Math.max(1, extent(P, 'solar')[1]) / 4, 1).hi, sHi = sStep * 4;
      var left = Math.ceil(textW('100%', FS, 400, T.sans)) + 10;
      var rightW = Math.ceil(textW(fmt(sHi), FS, 400, T.sans)) + 10;
      var pr = w - rightW, step = (pr - left) / n;
      var yDay = h - 4, yHour = yDay - 17, base = yHour - 16, gridTop = TOP + 8;
      var y = function (v) { return base - (v / 100) * (base - gridTop); };
      var ys = function (v) { return base - (v / sHi) * (base - gridTop); };
      var out = '';

      [0, 25, 50, 75, 100].forEach(function (t, k) {
        if (t > 0) out += line(left, crisp(y(t)), pr, crisp(y(t)), T.grid, 1);
        out += txt(left - 8, y(t) + 4.5, t === 100 ? '100%' : String(t), { fill: T.ink3, anchor: 'end' });
        out += txt(pr + 8, y(t) + 4.5, fmt(sStep * k), { fill: T.ink3 });
      });
      out += txt(w, 17, 'Solar kW', { fill: T.ink3, weight: 500, anchor: 'end' });

      out += hourAxis(T, P, left, step, gridTop - 8, base, yHour, yDay, w);

      // solar: flat light bars, centred in each hour slot
      var bw = Math.max(1, step * 0.62);
      P.forEach(function (p, i) {
        if (p.solar > 0) out += rect(left + (i + 0.5) * step - bw / 2, ys(p.solar), bw, base - ys(p.solar), { fill: T.bar });
      });
      out += line(left, crisp(base), pr, crisp(base), T.ink, 1);

      var yR = y(RESERVE_PCT);
      out += line(left, yR, pr, yR, T.warn, 1.5, '6 4');

      // battery: step line, one flat run per hour
      var pts = [];
      P.forEach(function (p, i) { pts.push([left + i * step, y(p.soc)], [left + (i + 1) * step, y(p.soc)]); });
      out += el('path', { d: 'M' + pts.map(function (q) { return r1(q[0]) + ' ' + r1(q[1]); }).join('L'),
        fill: 'none', stroke: T.accent, 'stroke-width': 2, 'stroke-linejoin': 'miter' });

      // direct labels: "Battery %" at the line end, "20% reserve" wherever the line leaves room
      var obs = polyObs(pts, 3), lastY = y(P[n - 1].soc), bw2 = textW('Battery %', FS, 600, T.sans);
      var bc = pick(keep([tbox(pr - 2, lastY - 7, bw2, 'end'), tbox(pr - 2, lastY + 17, bw2, 'end')],
        function (c) { return c.y0 >= gridTop - 10 && c.y1 <= base; }).concat([tbox(pr - 2, lastY - 7, bw2, 'end')]), obs);
      obs.push(bc);
      var rc = pick(keep(slideCands(T, [RESERVE_PCT + '% reserve'], yR, left, pr, 500).reverse(),
        function (c) { return c.y1 <= base; }), obs);
      out += txt(rc.x, rc.b, rc.s, { fill: T.warn, weight: 500, anchor: rc.anchor, halo: T.paper });
      out += txt(bc.x, bc.b, 'Battery %', { fill: T.accent, weight: 600, anchor: 'end', halo: T.paper });

      svg.innerHTML = out;
    });
    m.render();
    return { destroy: m.destroy };
  }

  /* ---------- 3. temperature vs demand scatter ---------- */

  function temperature(container, rows) {
    var P = prep(rows), n = P.length;
    var label = 'Predicted demand against ambient temperature';
    if (n) {
      var te = extent(P, 'temp'), ke = extent(P, 'kw');
      label += ', ' + n + ' hours. Temperature ' + fmt(r1(te[0])) + ' to ' + fmt(r1(te[1])) +
        ' °C, demand ' + Math.round(ke[0]) + ' to ' + Math.round(ke[1]) +
        ' kW. Filled circles are storage hours, hollow circles are main-grid hours.';
    }
    var m = mount(container, label, function (svg, w, h, T) {
      if (!n) return emptyState(svg, T);
      var te = extent(P, 'temp'), pad = Math.max(0.5, (te[1] - te[0]) * 0.05);
      var x0 = te[0] - pad, x1 = te[1] + pad, xt = ticksWithin(x0, x1, w < 500 ? 5 : 9);
      var ax = axis(0, Math.max(extent(P, 'kw')[1], OVERLOAD_KW), h < 240 ? 3 : 4);
      var left = Math.ceil(textW(fmt(ax.hi), FS, 400, T.sans)) + 10, pr = w - 2;
      var yTitle = h - 4, yTick = yTitle - 18, base = yTick - 16, gridTop = TOP + 8;
      var x = function (v) { return left + 6 + ((v - x0) / (x1 - x0)) * (pr - left - 12); };
      var y = function (v) { return base - (v / ax.hi) * (base - gridTop); };
      var rad = w < 500 ? 3.5 : 4.5, out = '';

      ax.ticks.forEach(function (t) {
        if (t > 0) out += line(left, crisp(y(t)), pr, crisp(y(t)), T.grid, 1);
        out += txt(left - 8, y(t) + 4.5, fmt(t), { fill: T.ink3, anchor: 'end' });
      });
      out += txt(left - 8, 17, 'kW', { fill: T.ink3, anchor: 'end' });
      out += line(left, crisp(base), pr, crisp(base), T.ink, 1);
      xt.forEach(function (t) {
        out += line(crisp(x(t)), base, crisp(x(t)), base + 5, T.ink, 1);
        out += txt(x(t), yTick, fmt(t), { fill: T.ink3, anchor: 'middle' });
      });
      out += txt(pr, yTitle, 'Ambient temperature, °C', { fill: T.ink3, anchor: 'end' });

      // key, top-left inside the plot (its box keeps threshold labels away)
      var kx = left + 10, ky = gridTop + 18, gx = kx + 13 + textW('storage', FS, 400, T.sans) + 16;
      var obs = P.map(function (p) { return ptObs(x(p.temp), y(p.kw), rad + 2); });
      obs.push({ x0: kx - 2, x1: gx + 13 + textW('grid', FS, 400, T.sans), y0: ky - 12, y1: ky + 4 });
      var th = thresholds(T, y, left, pr, obs);
      out += th.under;

      // grid hours hollow, storage hours filled (drawn last so they stay legible)
      P.forEach(function (p) {
        if (!p.storage) out += dot(x(p.temp), y(p.kw), rad, { fill: 'none', stroke: T.ink, 'stroke-width': 1.5 });
      });
      P.forEach(function (p) {
        if (p.storage) out += dot(x(p.temp), y(p.kw), rad, { fill: T.accent, stroke: T.paper, 'stroke-width': 1 });
      });

      out += th.over;
      out += dot(kx + 4, ky - 4.5, 4.5, { fill: T.accent });
      out += txt(kx + 13, ky, 'storage', { fill: T.ink2, halo: T.paper });
      out += dot(gx + 4, ky - 4.5, 3.75, { fill: 'none', stroke: T.ink, 'stroke-width': 1.5 });
      out += txt(gx + 13, ky, 'grid', { fill: T.ink2, halo: T.paper });

      svg.innerHTML = out;
    });
    m.render();
    return { destroy: m.destroy };
  }

  window.GPCharts = { forecast: forecast, battery: battery, temperature: temperature };
})();
