/* analytics beacon — cookieless, first-party, no dependencies.
 * Sends one `pageview` per load plus a `heartbeat` every 30s while the tab is
 * visible (GA-style realtime active users / engaged sessions).
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
    var url = "/analytics-beacon/collect";

    function send(type) {
      try {
        var payload = JSON.stringify({
          site: site,
          type: type,
          p: location.pathname + location.search,
          r: document.referrer || ""
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
        } else {
          var x = new XMLHttpRequest();
          x.open("POST", url, true);
          x.setRequestHeader("Content-Type", "application/json");
          x.send(payload);
        }
      } catch (e) { /* never break the host page */ }
    }

    send("pageview");

    setInterval(function () {
      if (document.visibilityState === "visible") send("heartbeat");
    }, 30000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") send("heartbeat");
    });
  } catch (e) { /* noop */ }
})();
