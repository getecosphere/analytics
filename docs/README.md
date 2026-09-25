# analytics

Privacy-first traffic analytics for Eco estates. One binary, no third-party
scripts required: a **cookieless first-party beacon** captures pageviews and a
small **dashboard** shows totals, a realtime counter, a timeline chart, top
pages, referrers and countries.

## Why

Google Analytics and Cloudflare both answer "how many people visit?", but each
is per-property, sends (or holds) data elsewhere, and GA needs a consent
banner. `analytics` is the estate's own data: it lives in your Postgres or on
disk, is queryable, and composes like every other LXS.

## Two sources, one store

- **First-party beacon (this version).** A tiny `a.js` posts one pageview per
  load plus a heartbeat every 30s while the tab is visible, to
  `POST /analytics-beacon/collect`. Cookieless: a visitor is a daily
  `fnv1a(ip + user-agent + day)` hash — no cookie, no fingerprint kept. Device
  (desktop/mobile/tablet) is classified from the User-Agent.
- **Cloudflare / GA4 (planned).** Optional feeds that merge into the same
  timeline, so "requests (edge)" and "visitors (human)" sit side by side.

## Dashboard

The superadmin dashboard shows: live active users (5 min, GA-style), totals and
a timeline, a **locations choropleth map** + country list, **devices** donut,
**new vs returning** donut, **keywords** (from referrers), top pages and top
referrers. It renders the estate's real header/footer and follows the estate
light/dark theme.

The world map is [svg-maps/world](https://github.com/VictorCazanave/svg-maps),
licensed CC BY 4.0.

## Compose

```yaml
services:
  analytics:
    lxs: analytics@0.1.0
    port: 4300
    config:
      DATA_DIR: /var/lib/eco-analytics/<estate>
      SITE: <estate>
    access:
      routes:
        - { path: /analytics-beacon, level: public }
        - { path: /analytics-beacon/*, level: public }
        - { path: /analytics-app, level: role:superadmin, cookie: eco_token }
        - { path: /analytics-app/*, level: role:superadmin, cookie: eco_token }
```

Then add the beacon to the estate's pages:

```html
<script defer src="/analytics-beacon/a.js" data-site="my-estate"></script>
```

Open `/analytics-app` as a `superadmin` to see the dashboard.

## Env

| Var | Default | Role |
|---|---|---|
| `SERVER_PORT` | `4300` | listen port |
| `DATA_DIR` | `./data` | directory for `events.ndjson` (persist across deploys) |
| `SITE` | `default` | site label recorded on every event |

## Storage

v0.1 appends NDJSON to `DATA_DIR/events.ndjson` and keeps events in memory for
aggregation. Postgres/SQLite backends land in v0.2 behind the same API.

## Logging

NDJSON to stdout, per the Eco LXS logging contract.
