/* analytics beacon — cookieless, first-party, no dependencies.
 * Sends one `pageview` per load plus a `heartbeat` every 30s while the tab is
 * visible (GA-style realtime active users / engaged sessions).
 * Usage: <script defer src="/analytics-beacon/a.js" data-site="getecosphere"></script>
 *
 * OS-style SPAs (one URL, app windows) can report a "virtual view" instead of
 * relying on the URL bar:
 *   window.ecoAnalytics.view("python");   // when an app gains focus
 *   window.ecoAnalytics.view("");         // back to the desktop
 * The active view rides along on every heartbeat, so "live" counts are per-app.
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
    var app = (s && s.getAttribute("data-app")) || "";

    function send(type) {
      try {
        var payload = JSON.stringify({
          site: site,
          type: type,
          p: location.pathname + location.search,
          r: document.referrer || "",
          app: app
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

    // OS-style virtual views: the focused app is the visitor's real "page".
    // A change of view is a pageview; the view stays attributed to heartbeats.
    window.ecoAnalytics = {
      view: function (key) {
        key = typeof key === "string" ? key : "";
        if (key === app) return;
        app = key;
        send("pageview");
      }
    };

    setInterval(function () {
      if (document.visibilityState === "visible") send("heartbeat");
    }, 30000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") send("heartbeat");
    });
  } catch (e) { /* noop */ }
})();
