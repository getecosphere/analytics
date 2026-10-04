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

    // Optional owner opt-out: with `data-skip-roles="superadmin"` the beacon
    // no-ops while the (same-origin) estate session carries one of those roles,
    // so the owner's own browsing is never counted. Reads the estate session
    // object (localStorage/sessionStorage) — no token, only role names.
    var skipRoles = ((s && s.getAttribute("data-skip-roles")) || "").toLowerCase()
      .split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var sessionKey = (s && s.getAttribute("data-session-key")) || "eco_session";
    function isOwner() {
      if (!skipRoles.length) return false;
      try {
        var raw = localStorage.getItem(sessionKey) || sessionStorage.getItem(sessionKey);
        if (!raw) return false;
        var u = (JSON.parse(raw) || {}).user || {};
        var roles = [u.role].concat(u.roles || []).filter(Boolean).map(function (r) { return String(r).toLowerCase(); });
        for (var i = 0; i < skipRoles.length; i++) { if (roles.indexOf(skipRoles[i]) >= 0) return true; }
      } catch (e) { /* ignore */ }
      return false;
    }

    // In-app/embedded browser (Instagram, Threads, TikTok, …): a webview,
    // where third-party sign-in (Google OAuth) cannot complete. Reported as a
    // `wv` dimension so the dashboard can split webview traffic.
    function inApp() {
      try {
        var ua = (navigator.userAgent || "").toLowerCase();
        if (!ua) return false;
        if (/instagram|threads|fban|fbav|fb_iab|tiktok|bytedance|musical_ly|micromessenger|snapchat|pinterest|linkedin|line\//.test(ua)) return true;
        if (ua.indexOf("; wv)") >= 0) return true;
        if (ua.indexOf("android") >= 0 && ua.indexOf("version/") >= 0 && ua.indexOf("chrome") >= 0) return true;
        if ((ua.indexOf("iphone") >= 0 || ua.indexOf("ipad") >= 0 || ua.indexOf("ipod") >= 0) &&
            !/safari\/|crios|fxios|edgios/.test(ua)) return true;
      } catch (e) { /* ignore */ }
      return false;
    }

    function send(type) {
      try {
        if (isOwner()) return; // never count the owner/superadmin
        var payload = JSON.stringify({
          site: site,
          type: type,
          p: location.pathname + location.search,
          r: document.referrer || "",
          app: app,
          wv: inApp()
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
      },
      // Named domain event (e.g. a funnel step). Counted separately from
      // pageviews — `ecoAnalytics.event("signup_start")`.
      event: function (name) {
        name = typeof name === "string" ? name : "";
        if (!name || name === "pageview" || name === "heartbeat") return;
        send(name);
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
