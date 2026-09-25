/* analytics dashboard — vanilla JS, no dependencies. */
(function () {
  var range = "24h";

  function el(id) { return document.getElementById(id); }
  function n(x) { return (x || 0).toLocaleString(); }

  function rows(tbody, items, keyLabel, cls) {
    var t = el(tbody);
    if (!t) return;
    if (!items || !items.length) {
      t.innerHTML = '<tr><td colspan="2" class="empty">No data yet.</td></tr>';
      return;
    }
    t.innerHTML = items
      .map(function (it) {
        var k = it.key === "" ? "(unknown)" : it.key;
        return '<tr><td class="' + (cls || "") + '">' + escapeHtml(k) + '</td><td class="num">' + n(it.count) + "</td></tr>";
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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
    var pad = { l: 34, r: 8, t: 12, b: 26 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    var max = 1;
    series.forEach(function (d) { if (d.pageviews > max) max = d.pageviews; });
    var step = Math.ceil(max / 4);

    ctx.strokeStyle = "#1f2b27"; ctx.fillStyle = "#8ba69b"; ctx.font = "11px ui-sans-serif, sans-serif"; ctx.lineWidth = 1;
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
      var grad = ctx.createLinearGradient(0, y, 0, pad.t + ch);
      grad.addColorStop(0, "#34d399");
      grad.addColorStop(1, "rgba(52,211,153,0.18)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, bw, Math.max(bh, d.pageviews > 0 ? 2 : 0));
    });

    // x labels (sparse)
    ctx.fillStyle = "#8ba69b";
    var every = Math.ceil(nBars / 8);
    series.forEach(function (d, i) {
      if (i % every !== 0) return;
      var x = pad.l + i * (bw + gap);
      ctx.fillText(String(d.t).slice(5), x, h - 8);
    });
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
    el("foot").textContent = "Ecosphere · analytics LXS · generated " + data.generated_at;
    drawChart(data.series);
    rows("pages", data.top_pages, "Path", "path");
    rows("refs", data.top_referrers, "Source");
    rows("countries", data.top_countries, "Country");
  }

  function load() {
    fetch("/analytics-app/api/summary?range=" + encodeURIComponent(range), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  }

  Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"), function (t) {
    t.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      range = t.getAttribute("data-range");
      load();
    });
  });

  window.addEventListener("resize", function () { load(); });
  load();
  setInterval(load, 4000);
})();
