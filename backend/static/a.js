/* analytics beacon — cookieless, first-party, no dependencies.
 * Usage: <script defer src="/analytics-beacon/a.js" data-site="getecosphere"></script>
 */
(function () {
  try {
    var s = document.currentScript;
    if (!s) {
      var all = document.getElementsByTagName("script");
      s = all[all.length - 1];
    }
    var site = (s && s.getAttribute("data-site")) || "";
    var payload = JSON.stringify({
      site: site,
      p: location.pathname + location.search,
      r: document.referrer || ""
    });
    var url = "/analytics-beacon/collect";
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    } else {
      var x = new XMLHttpRequest();
      x.open("POST", url, true);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(payload);
    }
  } catch (e) {
    /* never break the host page */
  }
})();
