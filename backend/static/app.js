/* analytics dashboard — vanilla JS, theme-aware, no dependencies. */
(function () {
  var range = "24h";
  var last = null;
  var nameByCode = {};
  var mapReady = false;

  function el(id) { return document.getElementById(id); }
  function n(x) { return (x || 0).toLocaleString(); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function svgNS() { return "http://www.w3.org/2000/svg"; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function rows(tbody, items, cls) {
    var t = el(tbody);
    if (!t) return;
    if (!items || !items.length) { t.innerHTML = '<tr><td colspan="2" class="an-empty">No data yet.</td></tr>'; return; }
    t.innerHTML = items.map(function (it) {
      var k = it.key === "" ? "(unknown)" : it.key;
      return '<tr><td class="' + (cls || "") + '">' + escapeHtml(k) + '</td><td class="num">' + n(it.count) + "</td></tr>";
    }).join("");
  }

  function drawChart(series) {
    var cv = el("chart");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = 240;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!series || !series.length) return;

    var colBorder = cssVar("--color-border") || "#ded9e1";
    var colMuted = cssVar("--color-muted") || "#665f6e";
    var colAccent = cssVar("--color-success") || "#198653";

    var pad = { l: 34, r: 8, t: 12, b: 26 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var max = 1;
    series.forEach(function (d) { if (d.pageviews > max) max = d.pageviews; });
    var step = Math.ceil(max / 4);

    ctx.strokeStyle = colBorder; ctx.fillStyle = colMuted; ctx.font = "11px ui-sans-serif, sans-serif"; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = pad.t + ch - (ch * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
      ctx.fillText(String(step * i), 6, y + 3);
    }

    var nBars = series.length;
    var gap = nBars > 40 ? 1 : nBars > 16 ? 3 : 8;
    var bw = Math.max(1, (cw - gap * (nBars - 1)) / nBars);
    series.forEach(function (d, i) {
      var x = pad.l + i * (bw + gap);
      var bh = (d.pageviews / max) * ch;
      var y = pad.t + ch - bh;
      ctx.fillStyle = colAccent;
      ctx.fillRect(x, y, bw, Math.max(bh, d.pageviews > 0 ? 2 : 0));
    });

    ctx.fillStyle = colMuted;
    var every = Math.ceil(nBars / 8);
    series.forEach(function (d, i) {
      if (i % every !== 0) return;
      ctx.fillText(String(d.t).slice(5), pad.l + i * (bw + gap), h - 8);
    });
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
    box.innerHTML = '<svg viewBox="0 0 140 140" width="150" height="150">' +
      '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + (cssVar("--color-surface-raised") || "#eee") + '" stroke-width="' + SW + '"></circle>' +
      circles +
      '<text x="70" y="68" text-anchor="middle" font-size="22" font-weight="800" fill="' + (cssVar("--color-ink") || "#000") + '">' + n(total) + "</text>" +
      '<text x="70" y="86" text-anchor="middle" font-size="10" fill="' + (cssVar("--color-muted") || "#666") + '">total</text>' +
      "</svg>";
  }

  function legend(id, segs) {
    var box = el(id);
    if (!box) return;
    var total = segs.reduce(function (a, s) { return a + (s.value || 0); }, 0) || 1;
    box.innerHTML = segs.map(function (s) {
      var pct = Math.round((s.value / total) * 100);
      return '<div class="an-li"><span class="an-sw" style="background:' + s.color + '"></span><span class="an-lk">' +
        escapeHtml(s.label) + '</span><span class="an-lv">' + n(s.value) + " · " + pct + "%</span></div>";
    }).join("");
  }

  function colorMap(countries) {
    var box = el("map");
    if (!box || !mapReady) return;
    var counts = {};
    (countries || []).forEach(function (c) { counts[String(c.key || "").toLowerCase()] = c.count; });
    var max = 1;
    Object.keys(counts).forEach(function (k) { if (counts[k] > max) max = counts[k]; });
    var brand = cssVar("--color-brand") || "#5b3fd6";
    var base = cssVar("--color-surface-raised") || "#eee";
    box.querySelectorAll("path").forEach(function (p) {
      var id = p.id;
      if (!id) return;
      var c = counts[id];
      if (c) {
        p.style.fill = brand;
        p.setAttribute("fill-opacity", (0.25 + 0.75 * (c / max)).toFixed(2));
        p.style.cursor = "pointer";
      } else {
        p.style.fill = base;
        p.removeAttribute("fill-opacity");
        p.style.cursor = "default";
      }
      var name = nameByCode[id] || id.toUpperCase();
      var t = p.querySelector("title");
      if (!t) { t = document.createElementNS(svgNS(), "title"); p.appendChild(t); }
      t.textContent = name + (c ? " — " + c + " views" : "");
    });
  }

  function renderCountries(countries) {
    var box = el("countries");
    if (!box) return;
    if (!countries || !countries.length) { box.innerHTML = '<div class="an-empty">No location data yet.</div>'; return; }
    var max = 1;
    countries.forEach(function (c) { if (c.count > max) max = c.count; });
    box.innerHTML = countries.map(function (c) {
      var code = String(c.key || "").toLowerCase();
      var name = nameByCode[code] || (c.key || "Unknown");
      var pct = Math.round((c.count / max) * 100);
      return '<div class="an-cl"><span class="an-cname">' + escapeHtml(name) + '</span><span class="an-ccount">' + n(c.count) +
        '</span><span class="an-cbar"><i style="width:' + pct + '%"></i></span></div>';
    }).join("");
  }

  function render(data) {
    el("site").textContent = data.site || "—";
    el("livePv").textContent = n(data.live.pageviews);
    el("liveVis").textContent = n(data.live.visitors);
    el("todayPv").textContent = n(data.today.pageviews);
    el("todayVis").textContent = n(data.today.visitors);
    el("totPv").textContent = n(data.total.pageviews);
    el("totVis").textContent = n(data.total.visitors);
    el("rangeLabel").textContent = range === "24h" ? "hourly" : range === "30d" ? "30-day" : "7-day";
    el("chartTitle").textContent = "Pageviews · " + data.range;
    el("liveLabel").textContent = "live · updated " + new Date().toLocaleTimeString();
    drawChart(data.series);
    rows("pages", data.top_pages, "path");
    rows("refs", data.top_referrers);

    var brand = cssVar("--color-brand") || "#5b3fd6";
    var success = cssVar("--color-success") || "#198653";
    var accent = "#f59e0b";
    var subtle = cssVar("--color-subtle") || "#999";

    var dev = {};
    (data.devices || []).forEach(function (d) { dev[d.key] = d.count; });
    var devSegs = [
      { label: "desktop", value: dev["desktop"] || 0, color: brand },
      { label: "mobile", value: dev["mobile"] || 0, color: success },
      { label: "tablet", value: dev["tablet"] || 0, color: accent },
      { label: "unknown", value: dev["unknown"] || 0, color: subtle }
    ].filter(function (s) { return s.value > 0 || s.label !== "unknown"; });
    donut("devDonut", devSegs);
    legend("devLegend", devSegs);

    var nr = data.new_vs_returning || { new: 0, returning: 0 };
    var nrSegs = [
      { label: "new", value: nr["new"] || 0, color: brand },
      { label: "returning", value: nr["returning"] || 0, color: success }
    ];
    donut("nrDonut", nrSegs);
    legend("nrLegend", nrSegs);

    var kws = data.top_keywords || [];
    if (!kws.length) {
      el("keywords").innerHTML = '<tr><td colspan="2" class="an-empty">(not provided)</td></tr>';
    } else {
      rows("keywords", kws);
    }

    colorMap(data.top_countries);
    renderCountries(data.top_countries);
  }

  function loadMap() {
    fetch("/analytics-app/static/world.svg")
      .then(function (r) { return r.text(); })
      .then(function (svg) {
        var box = el("map");
        if (!box) return;
        box.innerHTML = svg;
        var s = box.querySelector("svg");
        if (s) { s.removeAttribute("width"); s.removeAttribute("height"); }
        box.querySelectorAll("path").forEach(function (p) {
          if (p.id) nameByCode[p.id] = p.getAttribute("aria-label") || p.id;
        });
        mapReady = true;
        if (last) render(last);
      })
      .catch(function () {});
  }

  function load() {
    fetch("/analytics-app/api/summary?range=" + encodeURIComponent(range), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { last = d; render(d); })
      .catch(function () {});
  }

  Array.prototype.forEach.call(document.querySelectorAll("#tabs .an-tab"), function (t) {
    t.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("#tabs .an-tab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      range = t.getAttribute("data-range");
      load();
    });
  });

  new MutationObserver(function () { if (last) render(last); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", function () { if (last) drawChart(last.series); });

  loadMap();
  load();
  setInterval(load, 4000);
})();
