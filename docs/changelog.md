# analytics changelog

## 0.1.0 (2026-09-25)
- First publish. Cookieless first-party pageview beacon (`/analytics-beacon/a.js`
  + `POST /analytics-beacon/collect`) and a superadmin dashboard
  (`/analytics-app`) with live counter, timeline chart, top pages, referrers
  and countries.
- Append-only NDJSON store (`DATA_DIR/events.ndjson`) loaded into memory for
  aggregation; `GET /analytics-app/api/summary?range=24h|7d|30d`.
- Cloudflare zone/RUM and GA4 feeds are designed into the same store and land
  in a later version.
