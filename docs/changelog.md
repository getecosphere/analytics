# analytics changelog

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
