# analytics changelog

## 0.8.0 (2026-10-02)
- **Zoomable realtime chart (app view).** The app-view graph is now an
  interactive timeline: the mouse **wheel zooms** and **drag pans** the window
  (anchored at the cursor, like Google Analytics), bounded from **1 second to
  30 days**; the `24 jam / 7 hari / 30 hari` tabs are presets, and double-click
  resets to the active tab. At fine zoom the bars read like a heartbeat — each
  bar is the distinct users active in that bucket — with a **concurrent-users
  line** (presence: a visitor stays "active" for 60s after their last event)
  so the pulse is continuous rather than a bare spike train.
- **New `GET /analytics-app/api/series?from&to&buckets`.** Returns ~`buckets`
  points over `[from, to]` (max 30 days) with `{t, users, events, pv,
  concurrent}`. The server picks a "nice" step (1s…1d) and answers from
  in-memory **multi-resolution rollups** (minute, hour, day) so the on-screen
  bucket count stays bounded; raw events back sub-minute zoom. The old
  `/api/summary` endpoint is unchanged.

## 0.7.0 (2026-10-01)
- **Owner opt-out (`data-skip-roles`).** The beacon now accepts
  `data-skip-roles="superadmin"` (comma list) plus optional
  `data-session-key` (default `eco_session`): while the same-origin estate
  session carries one of those roles, the beacon no-ops — so the owner's own
  browsing is never counted, giving clean traffic figures. Client-side only
  (roles read from the estate session object, no token); additive, backward
  compatible when the attribute is absent.

## 0.6.0 (2026-10-01)
- **Public minimal stats.** New `GET /analytics-beacon/stats?range=24h|7d|30d`
  returns only aggregate counts — `views`, `visitors`, `active` — with no pages,
  referrers, keywords, or countries. Meant for lightweight, public widgets (e.g.
  the OS footer) that must not call the superadmin-only `/analytics-app/api/summary`.

## 0.5.0 (2026-10-01)
- **Second dashboard view (`VIEW=app`).** `/analytics-app` can now serve a
  self-contained, **app-centric** dashboard for OS-style SPAs — no estate
  marketing chrome, no `/static/style.css`/`/images` dependency, theme-aware
  (follows `localStorage["rwid_theme"]`), and **mobile-first** (stacked cards,
  responsive panels). It leads with application usage: active-now, apps focused
  right now, top apps by views, a views timeline, devices, new-vs-returning and
  locations. The default view is unchanged — omit `VIEW` and getecosphere.com's
  dashboard renders exactly as before. Config field `VIEW` (default `default`).

## 0.4.0 (2026-09-30)
- **App dimension (OS-style SPAs).** An event may now carry `app` — a "virtual
  view" for apps whose UI lives in windows under a single URL. The beacon
  exposes `window.ecoAnalytics.view(key)` (call on window focus; `""` back to
  the desktop); a change of view counts as a pageview and the active view rides
  on every heartbeat. Summary gains `top_apps` (per-app views over the range)
  and `live.apps` (distinct active visitors per focused app, 5-min window).
  The dashboard adds an **Apps** panel: live chips + a range table. Real page
  paths stay clean (no synthetic URLs). Backward compatible — `app` is optional.

## 0.3.1 (2026-09-25)
- Devices donut excludes the `unknown` bucket (events recorded before device
  classification existed), so it reflects only classified traffic.

## 0.3.0 (2026-09-25)
- **Locations map.** A choropleth world map (embedded `svg-maps/world`, CC BY
  4.0) highlights the countries with traffic, beside a list with full country
  names and proportional bars.
- **Devices.** `desktop` / `mobile` / `tablet` classified from the User-Agent,
  shown as a donut with a count + percentage legend.
- **New vs returning.** A stable pseudonymous visitor id (ip + user-agent, not
  day-rotated) classifies the range's visitors as new or returning.
- **Keywords.** Search terms parsed from referrer query strings (`?q=…`);
  shown as “(not provided)” when absent, matching Google Analytics.

## 0.2.0 (2026-09-25)
- **Heartbeat tracking.** The beacon now sends a `heartbeat` every 30s while the
  tab is visible (and on tab re-focus), so "Active now · 5 min" reflects
  engaged visitors like Google Analytics Realtime. Pageview totals stay clean
  (heartbeats never inflate them).
- **Estate-native chrome.** The dashboard now renders the estate's real header
  and footer (same markup + `/static/style.css`), and follows the estate theme:
  light/dark is read from `localStorage["eco-theme"]` / `data-theme`, the header
  toggle is shared with the rest of the site, and the chart re-draws on theme
  change.

## 0.1.0 (2026-09-25)
- First publish. Cookieless first-party pageview beacon (`/analytics-beacon/a.js`
  + `POST /analytics-beacon/collect`) and a superadmin dashboard
  (`/analytics-app`) with live counter, timeline chart, top pages, referrers
  and countries.
- Append-only NDJSON store (`DATA_DIR/events.ndjson`) loaded into memory for
  aggregation; `GET /analytics-app/api/summary?range=24h|7d|30d`.
- Cloudflare zone/RUM and GA4 feeds are designed into the same store and land
  in a later version.
