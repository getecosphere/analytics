/* Application Analytics — tampilan ke-2 (VIEW=app). Vanilla JS, tanpa dependensi. */
(function () {
  var range = "24h";
  var last = null;

  function el(id) { return document.getElementById(id); }
  function n(x) { return (x || 0).toLocaleString(); }
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

  function drawChart(series) {
    var cv = el("vaChart");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight || 200;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!series || !series.length) return;

    var colBorder = varColor("--line", "#ddd");
    var colMuted = varColor("--label", "#666");
    var colAccent = varColor("--accent", "#e0a63a");

    var pad = { l: 32, r: 8, t: 10, b: 24 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var max = 1;
    series.forEach(function (d) { if (d.pageviews > max) max = d.pageviews; });
    var step = Math.ceil(max / 4);

    ctx.strokeStyle = colBorder; ctx.fillStyle = colMuted; ctx.font = "10px ui-sans-serif, sans-serif"; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = pad.t + ch - (ch * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
      ctx.fillText(String(step * i), 4, y + 3);
    }

    var nBars = series.length;
    var gap = nBars > 40 ? 1 : nBars > 16 ? 3 : 7;
    var bw = Math.max(1, (cw - gap * (nBars - 1)) / nBars);
    series.forEach(function (d, i) {
      var x = pad.l + i * (bw + gap);
      var bh = (d.pageviews / max) * ch;
      ctx.fillStyle = colAccent;
      ctx.fillRect(x, pad.t + ch - bh, bw, Math.max(bh, d.pageviews > 0 ? 2 : 0));
    });

    ctx.fillStyle = colMuted;
    var every = Math.ceil(nBars / 7);
    series.forEach(function (d, i) {
      if (i % every !== 0) return;
      ctx.fillText(String(d.t).slice(5), pad.l + i * (bw + gap), h - 6);
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
    el("vaRangeLabel").textContent = range === "24h" ? "per jam · 24 jam" : range === "30d" ? "30 hari terakhir" : "7 hari terakhir";

    drawChart(data.series);
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

  Array.prototype.forEach.call(document.querySelectorAll("#vaTabs .va-tab"), function (t) {
    t.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("#vaTabs .va-tab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      range = t.getAttribute("data-range");
      load();
    });
  });

  window.addEventListener("resize", function () { if (last) drawChart(last.series); });
  new MutationObserver(function () { if (last) render(last); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

  load();
  setInterval(load, 5000);
})();
