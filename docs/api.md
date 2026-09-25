# analytics API

Base: the service listens on `SERVER_PORT`. In an estate the gateway exposes
two prefixes: the public beacon at `/analytics-beacon/*`, and the dashboard +
API at `/analytics-app/*` (gated `role:superadmin`).

## Beacon (public)

### GET /analytics-beacon/a.js
The tracker. Add to any page:

```html
<script defer src="/analytics-beacon/a.js" data-site="my-estate"></script>
```

It posts one pageview via `navigator.sendBeacon` (fallback `XMLHttpRequest`).

### POST /analytics-beacon/collect
Auth: none. Body (JSON):

```json
{ "site": "getecosphere", "p": "/pricing", "r": "https://google.com/" }
```

Also accepted: `path` (alias `p`), `referrer`/`ref` (alias `r`). Country is read
from `CF-IPCountry`; the visitor id is a daily hash of client IP + user-agent.
Returns `204`. CORS `*`.

### GET /analytics-beacon/health
`{"status":"ok","service":"analytics"}`.

## Dashboard + API (superadmin)

### GET /analytics-app
The HTML dashboard. Fetches `/analytics-app/api/summary` and refreshes every
4 seconds.

### GET /analytics-app/api/summary?range=24h|7d|30d
```json
{
  "range": "7d",
  "site": "getecosphere",
  "generated_at": "2026-09-25T00:00:00Z",
  "total":     { "pageviews": 0, "visitors": 0 },
  "today":     { "pageviews": 0, "visitors": 0 },
  "live":      { "window_seconds": 300, "pageviews": 0, "visitors": 0 },
  "series":    [ { "t": "2026-09-19", "pageviews": 0, "visitors": 0 } ],
  "top_pages": [ { "key": "/", "count": 0 } ],
  "top_referrers": [ { "key": "(direct)", "count": 0 } ],
  "top_countries": [ { "key": "ID", "count": 0 } ],
  "devices": [ { "key": "desktop", "count": 0 } ],
  "new_vs_returning": { "new": 0, "returning": 0 },
  "top_keywords": [ { "key": "compose software", "count": 0 } ]
}
```

`range=24h` buckets hourly; `7d`/`30d` bucket daily. `devices` is classified
from the User-Agent; `new_vs_returning` uses a stable (non-day-rotated)
pseudonymous id per device/browser; `top_keywords` comes from referrer query
strings and is often empty (search engines hide it) → the dashboard shows
“(not provided)”.

### GET /analytics-app/api/health
Health for the analytics service.
