/* Application Analytics — tampilan ke-2 (VIEW=app). Vanilla JS, tanpa dependensi. */
(function () {
  var range = "24h";
  var last = null;
  var series = null;
  // Chart viewport (unix seconds). Tabs are presets; the wheel zooms and drag
  // pans freely within [now - 30d, now].
  var viewFrom = 0, viewTo = 0;
  var live = true;
  var BUCKETS = 160;
  var MAX_SPAN = 30 * 86400;
  var seriesTimer = null;

  function el(id) { return document.getElementById(id); }
  function n(x) { return (x || 0).toLocaleString(); }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function varColor(name, fallback) { return cssVar(name) || fallback; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rows(tbody, items) {
    var t = el(tbody);
    if (!t) return;
    if (!items || !items.length) {
      t.innerHTML = '<tr><td colspan="2" class="va-empty">Belum ada data.</td></tr>';
      return;
    }
    t.innerHTML = items.map(function (it) {
      var k = it.key === "" ? "(tak dikenal)" : it.key;
      return '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + n(it.count) + "</td></tr>";
    }).join("");
  }

  // ── time formatting ──────────────────────────────────────────────────────
  function pad2(x) { return (x < 10 ? "0" : "") + x; }
  function axisLabel(ts, step) {
    var d = new Date(ts * 1000);
    if (step < 3600) {
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (step < 60 ? ":" + pad2(d.getSeconds()) : "");
    }
    if (step < 86400) return pad2(d.getHours()) + ":00";
    return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function humanSpan(sec) {
    if (sec < 60) return Math.round(sec) + " dtk";
    if (sec < 3600) return Math.round(sec / 60) + " mnt";
    if (sec < 86400) return (sec / 3600).toFixed(sec % 3600 ? 1 : 0) + " jam";
    return (sec / 86400).toFixed(sec % 86400 ? 1 : 0) + " hari";
  }
  function humanStep(step) {
    if (step < 60) return step + " dtk";
    if (step < 3600) return Math.round(step / 60) + " mnt";
    if (step < 86400) return Math.round(step / 3600) + " jam";
    return Math.round(step / 86400) + " hari";
  }

  // ── chart ────────────────────────────────────────────────────────────────
  function chartW() { return Math.max(60, (el("vaChart").clientWidth || 600) - 44); }

  function drawSeries(s) {
    var cv = el("vaChart");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight || 200;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var pts = (s && s.points) || [];
    if (!pts.length) return;

    var colBorder = varColor("--line", "#ddd");
    var colMuted = varColor("--label", "#666");
    var colAccent = varColor("--accent", "#e0a63a");
    var colLine = varColor("--ok", "#34d399");

    var pad = { l: 34, r: 10, t: 12, b: 24 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var step = s.step || 1;
    var hasConc = false;
    var max = 1;
    pts.forEach(function (p) {
      if (p.users > max) max = p.users;
      if (p.concurrent != null) { hasConc = true; if (p.concurrent > max) max = p.concurrent; }
    });
    var yTop = Math.max(1, Math.ceil(max / 4) * 4);

    ctx.strokeStyle = colBorder; ctx.fillStyle = colMuted; ctx.font = "10px ui-sans-serif, sans-serif"; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var y = pad.t + ch - (ch * g) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
      ctx.fillText(String(Math.round((yTop * g) / 4)), 4, y + 3);
    }

    var nBars = pts.length;
    var gap = nBars > 120 ? 1 : nBars > 60 ? 1 : nBars > 30 ? 2 : nBars > 14 ? 4 : 7;
    var bw = Math.max(1, (cw - gap * (nBars - 1)) / nBars);

    // Bars = distinct users per bucket (the "heartbeat" spikes).
    ctx.fillStyle = colAccent;
    pts.forEach(function (p, i) {
      var x = pad.l + i * (bw + gap);
      var bh = (p.users / yTop) * ch;
      ctx.fillRect(x, pad.t + ch - bh, bw, Math.max(bh, p.users > 0 ? 2 : 0));
    });

    // Presence line = concurrent users (only at fine resolutions).
    if (hasConc) {
      ctx.strokeStyle = colLine; ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var x = pad.l + i * (bw + gap) + bw / 2;
        var y = pad.t + ch - ((p.concurrent || 0) / yTop) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.fillStyle = colMuted;
    var every = Math.ceil(nBars / 7);
    pts.forEach(function (p, i) {
      if (i % every !== 0) return;
      ctx.fillText(axisLabel(p.t, step), pad.l + i * (bw + gap), h - 6);
    });
  }

  function updateInfo() {
    var box = el("vaChartInfo");
    if (!box || !series) return;
    box.textContent = humanSpan(Math.floor(viewTo - viewFrom)) +
      " · langkah " + humanStep(series.step || 0) + (live ? " · live" : "");
  }

  function loadSeries() {
    if (!(viewTo > viewFrom)) return;
    var q = "/analytics-app/api/series?from=" + Math.floor(viewFrom) +
      "&to=" + Math.floor(viewTo) + "&buckets=" + BUCKETS;
    fetch(q, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { series = d; drawSeries(d); updateInfo(); })
      .catch(function () {});
  }
  function scheduleSeries() {
    if (seriesTimer) clearTimeout(seriesTimer);
    seriesTimer = setTimeout(loadSeries, 120);
  }

  function clampView() {
    // Preserve the span while bounding the viewport to [now-30d, now].
    var now = nowSec();
    var span = Math.min(MAX_SPAN, Math.max(1, viewTo - viewFrom));
    var lo = now - MAX_SPAN, hi = now - span;
    if (hi < lo) hi = lo;
    var anchor = viewFrom;
    if (anchor < lo) anchor = lo;
    if (anchor > hi) anchor = hi;
    viewFrom = anchor;
    viewTo = anchor + span;
  }

  function setViewport(from, to) {
    viewFrom = from; viewTo = to; clampView();
    live = (nowSec() - viewTo) < 2;
    loadSeries();
  }

  function bindChart() {
    var cv = el("vaChart");
    if (!cv) return;

    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = cv.getBoundingClientRect();
      var x = (e.clientX != null ? e.clientX : rect.left + rect.width / 2) - rect.left;
      var frac = Math.min(1, Math.max(0, (x - 34) / chartW()));
      var span = viewTo - viewFrom;
      var next = Math.min(MAX_SPAN, Math.max(1, span * Math.exp((e.deltaY || 0) * 0.0012)));
      var anchor = viewFrom + frac * span;
      viewFrom = anchor - frac * next;
      viewTo = viewFrom + next;
      clampView();
      live = (nowSec() - viewTo) < 2;
      scheduleSeries();
    }, { passive: false });

    var drag = null;
    cv.addEventListener("mousedown", function (e) {
      drag = { x: e.clientX, from: viewFrom, to: viewTo };
      cv.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var dt = ((e.clientX - drag.x) / chartW()) * (drag.to - drag.from);
      viewFrom = drag.from - dt; viewTo = drag.to - dt;
      clampView();
      live = (nowSec() - viewTo) < 2;
      scheduleSeries();
    });
    window.addEventListener("mouseup", function () {
      if (drag) { drag = null; cv.style.cursor = "grab"; }
    });
    cv.addEventListener("dblclick", function () { setRange(range); });
  }

  function donut(id, segs) {
    var box = el(id);
    if (!box) return;
    var total = segs.reduce(function (a, s) { return a + (s.value || 0); }, 0);
    var R = 52, SW = 15, C = 2 * Math.PI * R, off = 0;
    var circles = segs.map(function (s) {
      var frac = total > 0 ? s.value / total : 0;
      var len = C * frac;
      var seg = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="' + SW +
        '" stroke-dasharray="' + len + " " + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 70 70)"></circle>';
      off += len;
      return seg;
    }).join("");
    box.innerHTML = '<svg viewBox="0 0 140 140" width="136" height="136">' +
      '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + varColor("--srf2", "#eee") + '" stroke-width="' + SW + '"></circle>' +
      circles +
      '<text x="70" y="68" text-anchor="middle" font-size="22" font-weight="800" fill="' + varColor("--ink", "#000") + '">' + n(total) + "</text>" +
      '<text x="70" y="86" text-anchor="middle" font-size="10" fill="' + varColor("--label", "#666") + '">total</text>' +
      "</svg>";
  }

  function legend(id, segs) {
    var box = el(id);
    if (!box) return;
    var total = segs.reduce(function (a, s) { return a + (s.value || 0); }, 0) || 1;
    box.innerHTML = segs.map(function (s) {
      var pct = Math.round((s.value / total) * 100);
      return '<div class="va-li"><span class="va-sw" style="background:' + s.color + '"></span><span class="va-lk">' +
        escapeHtml(s.label) + '</span><span class="va-lv">' + n(s.value) + " · " + pct + "%</span></div>";
    }).join("");
  }

  function renderCountries(countries) {
    var box = el("vaCountries");
    if (!box) return;
    if (!countries || !countries.length) { box.innerHTML = '<div class="va-empty">Belum ada data lokasi.</div>'; return; }
    var max = 1;
    countries.forEach(function (c) { if (c.count > max) max = c.count; });
    box.innerHTML = countries.map(function (c) {
      var pct = Math.round((c.count / max) * 100);
      return '<div class="va-cl"><span class="va-cname">' + escapeHtml(c.key || "—") + '</span><span class="va-ccount">' + n(c.count) +
        '</span><span class="va-cbar"><i style="width:' + pct + '%"></i></span></div>';
    }).join("");
  }

  function renderApps(data) {
    var box = el("vaLiveApps");
    var live = (data.live && data.live.apps) || [];
    if (box) {
      box.innerHTML = live.length
        ? live.map(function (a) {
            return '<span class="va-chip"><em>' + escapeHtml(a.key) + '</em><b>' + n(a.count) + "</b></span>";
          }).join("")
        : '<span class="va-chip-empty">Tidak ada aplikasi yang difokus sekarang.</span>';
    }
    rows("vaApps", data.top_apps);
  }

  function render(data) {
    el("vaSite").textContent = data.site || "—";
    el("vaLive").textContent = "live · " + new Date().toLocaleTimeString();
    el("vaActive").textContent = n(data.live.visitors);
    el("vaLivePv").textContent = n(data.live.pageviews);
    el("vaToday").textContent = n(data.today.visitors);
    el("vaTodayPv").textContent = n(data.today.pageviews);
    el("vaVis").textContent = n(data.total.visitors);
    el("vaPv").textContent = n(data.total.pageviews);
    el("vaRangeLabel").textContent = range === "24h" ? "24 jam terakhir" : range === "30d" ? "30 hari terakhir" : "7 hari terakhir";

    renderApps(data);
    renderCountries(data.top_countries);

    var brand = varColor("--accent", "#e0a63a");
    var ok = varColor("--ok", "#34d399");
    var warn = varColor("--warn", "#f59e0b");

    var dev = {};
    (data.devices || []).forEach(function (d) { dev[d.key] = d.count; });
    var devSegs = [
      { label: "desktop", value: dev["desktop"] || 0, color: brand },
      { label: "mobile", value: dev["mobile"] || 0, color: ok },
      { label: "tablet", value: dev["tablet"] || 0, color: warn }
    ];
    donut("vaDevDonut", devSegs);
    legend("vaDevLegend", devSegs);

    var nr = data.new_vs_returning || { "new": 0, returning: 0 };
    var nrSegs = [
      { label: "baru", value: nr["new"] || 0, color: brand },
      { label: "kembali", value: nr["returning"] || 0, color: ok }
    ];
    donut("vaNrDonut", nrSegs);
    legend("vaNrLegend", nrSegs);
  }

  function load() {
    fetch("/analytics-app/api/summary?range=" + encodeURIComponent(range), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { last = d; render(d); })
      .catch(function () {});
  }

  function setRange(r) {
    range = r;
    var now = nowSec();
    var span = r === "7d" ? 7 * 86400 : r === "30d" ? 30 * 86400 : 86400;
    setViewport(now - span, now);
    load();
  }

  Array.prototype.forEach.call(document.querySelectorAll("#vaTabs .va-tab"), function (t) {
    t.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("#vaTabs .va-tab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      setRange(t.getAttribute("data-range"));
    });
  });

  window.addEventListener("resize", function () { if (series) drawSeries(series); });
  new MutationObserver(function () { if (series) drawSeries(series); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

  bindChart();
  setRange("24h");

  // Live: slide the window forward with wall-clock time and refresh.
  setInterval(function () {
    if (live) {
      var span = viewTo - viewFrom;
      viewTo = nowSec(); viewFrom = viewTo - span;
      clampView();
      loadSeries();
    }
    load();
  }, 4000);
})();
