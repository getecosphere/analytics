# analytics changelog

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
