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
{ "site": "getecosphere", "p": "/pricing", "r": "https://google.com/", "app": "" }
```

Also accepted: `path` (alias `p`), `referrer`/`ref` (alias `r`). Country is read
from `CF-IPCountry`; the visitor id is a daily hash of client IP + user-agent.
Returns `204`. CORS `*`.

`app` (optional): a virtual-view key for OS-style SPAs where the URL never
changes but the visitor's real view is the app window they have focused. The
beacon exposes it as a helper — call on focus change:

```js
window.ecoAnalytics.view("python");  // an app gains focus
window.ecoAnalytics.view("");        // back to the desktop
```

A change of view counts as a `pageview` (with `app` set); the active view rides
on every `heartbeat`, so live counts are per-app.

### GET /analytics-beacon/health
`{"status":"ok","service":"analytics"}`.

### GET /analytics-beacon/stats?range=24h|7d|30d
Public minimal aggregate for lightweight widgets — no breakdowns:
`{"range":"24h","views":373,"visitors":106,"active":3}`. (`views` = pageviews
in range; `active` = distinct visitors in the last 5 minutes.)

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
  "live":      { "window_seconds": 300, "pageviews": 0, "visitors": 0, "apps": [ { "key": "python", "count": 0 } ] },
  "series":    [ { "t": "2026-09-19", "pageviews": 0, "visitors": 0 } ],
  "top_pages": [ { "key": "/", "count": 0 } ],
  "top_apps":  [ { "key": "python", "count": 0 } ],
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

### GET /analytics-app/api/series?from=&to=&buckets=

Arbitrary-window series for the zoomable app-view chart — `from`/`to` are unix
seconds (max span 30 days; defaults to the last 24h), `buckets` is the on-screen
point budget (default 160, clamped 8–400). The server picks a "nice" step from
`1s, 2s, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 6h, 1d` so the
number of returned points stays bounded, and answers from multi-resolution
in-memory rollups (minute/hour/day) — raw events back sub-minute zoom.

```json
{
  "from": 1790899200, "to": 1790902800, "step": 1,
  "points": [
    { "t": 1790899200, "users": 1, "events": 1, "pv": 1, "concurrent": 2 }
  ]
}
```

- `t` — bucket start (unix seconds).
- `users` — distinct visitors active inside the bucket (the chart bars).
- `events` / `pv` — all events / pageviews in the bucket.
- `concurrent` — presence-derived concurrent users (a visitor stays active for
  `PRESENCE` = 60s after their last event). Only present at fine steps
  (`step < 60`), where it is drawn as the realtime pulse **line**; omitted
  (`null`) at coarse resolutions, where `users` bars already pulse.

### GET /analytics-app/api/health
Health for the analytics service.
