//! analytics — privacy-first traffic analytics LXS.
//!
//! v0.1 sources: a first-party, cookieless **pageview beacon** (`a.js` +
//! `POST /analytics-beacon/collect`). Events are appended to an NDJSON log and
//! kept in memory for fast aggregation. The dashboard + JSON API are meant to
//! sit behind the estate gateway at `role:superadmin`.
//!
//! v0.4 adds an optional `app` dimension: OS-style SPAs (one URL, app windows)
//! report a virtual view via `window.ecoAnalytics.view(key)`, so per-app
//! `top_apps` and per-app `live.apps` counters work without fake URLs.
//!
//! v0.8 adds `GET /analytics-app/api/series?from&to&buckets` — an
//! arbitrary-window series for the dashboard's wheel-zoom chart. It is answered
//! from in-memory multi-resolution rollups (minute/hour/day), with raw events
//! backing sub-minute zoom and a presence-derived concurrent-users line.
//!
//! Future sources (Cloudflare zone/RUM, GA4) plug into the same store.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

static DASHBOARD: &str = include_str!("../static/index.html");
static APP_CSS: &str = include_str!("../static/app.css");
static APP_JS: &str = include_str!("../static/app.js");
static BEACON_JS: &str = include_str!("../static/a.js");
static WORLD_SVG: &str = include_str!("../static/world.svg");
// Second view: a self-contained, app-centric dashboard for OS-style SPAs
// (selected with `VIEW=app`). The default view above is unchanged.
static VIEW_HTML: &str = include_str!("../static/view.html");
static VIEW_CSS: &str = include_str!("../static/view.css");
static VIEW_JS: &str = include_str!("../static/view.js");

const MAX_EVENTS: usize = 500_000;

/// Presence window (seconds) for the realtime "concurrent users" line. A
/// visitor counts as present at time `t` if they emitted any event in
/// `[t - PRESENCE, t]`. The beacon heartbeats every 30s, so 60s tolerates one
/// missed beat before a visitor decays out of the pulse.
const PRESENCE: i64 = 60;

fn kind_pageview() -> String {
    "pageview".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
struct Event {
    ts: i64,
    #[serde(default)]
    path: String,
    #[serde(default, rename = "ref")]
    refers: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    visitor: String,
    #[serde(default)]
    site: String,
    /// `pageview` (default) or `heartbeat` (engaged-time ping).
    #[serde(default = "kind_pageview", rename = "type")]
    kind: String,
    /// Stable pseudonymous id (ip+ua, NOT day-rotated) — new vs returning.
    #[serde(default)]
    vid: String,
    /// `desktop` | `mobile` | `tablet` | `unknown`.
    #[serde(default)]
    device: String,
    /// Search keyword parsed from a referrer query string, when present.
    #[serde(default)]
    keyword: String,
    /// Optional app/view key. On an OS-style SPA the URL never changes, but the
    /// visitor's real "view" is the app window they have focused — this carries
    /// that key so per-app traffic can be counted without fake URLs.
    #[serde(default)]
    app: String,
}

/// Aggregated counters for one rollup bucket (distinct visitor set + counts).
#[derive(Clone, Default)]
struct Agg {
    events: u64,
    pv: u64,
    users: HashSet<String>,
}

/// Multi-resolution rollups so any zoom window can be answered from a bounded
/// set of buckets instead of re-scanning every raw event: minute (fine, ~31d),
/// hour and day (coarse, long retention). Raw events still back the finest
/// (< 1 min) zoom where per-second detail is needed.
#[derive(Default)]
struct Rollups {
    minute: BTreeMap<i64, Agg>,
    hour: BTreeMap<i64, Agg>,
    day: BTreeMap<i64, Agg>,
}

fn add_roll(roll: &mut BTreeMap<i64, Agg>, key: i64, ev: &Event) {
    let a = roll.entry(key).or_default();
    a.events += 1;
    if ev.kind != "heartbeat" {
        a.pv += 1;
    }
    if !ev.visitor.is_empty() {
        a.users.insert(ev.visitor.clone());
    }
}

impl Rollups {
    fn add(&mut self, ev: &Event) {
        add_roll(&mut self.minute, ev.ts / 60, ev);
        add_roll(&mut self.hour, ev.ts / 3_600, ev);
        add_roll(&mut self.day, ev.ts / 86_400, ev);
        // Bound memory: keep ~31 days of minute detail. Older windows are
        // still served from the hour/day rollups via the step ladder.
        let keep = 31 * 1440;
        let cutoff = ev.ts / 60 - keep;
        if self.minute.len() > (keep + 1024) as usize {
            while self.minute.first_key_value().map_or(false, |(&k, _)| k < cutoff) {
                self.minute.pop_first();
            }
        }
    }
}

#[derive(Clone)]
struct AppState {
    events: Arc<Mutex<Vec<Event>>>,
    file: Arc<Mutex<Option<File>>>,
    rollups: Arc<Mutex<Rollups>>,
    site: String,
    /// Which dashboard to serve at `/analytics-app`: `default` (estate
    /// marketing chrome, for getecosphere.com) or `app` (self-contained,
    /// app-centric, mobile-friendly — for OS-style SPAs like RWID).
    view: String,
}

#[derive(Default, Deserialize)]
struct CollectBody {
    #[serde(default)]
    site: String,
    #[serde(default, alias = "p")]
    path: String,
    #[serde(default, alias = "r", alias = "referrer")]
    refers: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    app: String,
}

#[derive(Deserialize)]
struct SummaryQuery {
    #[serde(default)]
    range: Option<String>,
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn log(level: &str, msg: &str) {
    let ts = Utc
        .timestamp_opt(now_ts(), 0)
        .single()
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    println!(
        "{{\"ts\":\"{}\",\"level\":\"{}\",\"msg\":\"{}\",\"service\":\"analytics\"}}",
        ts, level, msg
    );
}

fn client_ip(headers: &HeaderMap) -> String {
    for key in ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] {
        if let Some(v) = headers.get(key).and_then(|v| v.to_str().ok()) {
            let first = v.split(',').next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    "0.0.0.0".to_string()
}

fn visitor_id(headers: &HeaderMap) -> String {
    let ip = client_ip(headers);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let day = now_ts() / 86_400;
    let h = fnv1a(&format!("{ip}|{ua}|{day}"));
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

fn country(headers: &HeaderMap) -> String {
    headers
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Stable pseudonymous id for a device/browser (ip + user-agent), used to tell
/// new from returning visitors. Not day-rotated, unlike `visitor_id`.
fn stable_id(headers: &HeaderMap) -> String {
    let h = fnv1a(&format!("{}|{}", client_ip(headers), user_agent(headers)));
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

fn detect_device(ua: &str) -> String {
    let u = ua.to_ascii_lowercase();
    if u.is_empty() {
        return "unknown".to_string();
    }
    if u.contains("ipad")
        || u.contains("tablet")
        || u.contains("kindle")
        || (u.contains("android") && !u.contains("mobile"))
    {
        "tablet".to_string()
    } else if u.contains("mobi") || u.contains("iphone") || u.contains("android") {
        "mobile".to_string()
    } else {
        "desktop".to_string()
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Pull a search keyword out of a referrer's query string (`?q=…`, `?query=…`,
/// `?p=…`, `?text=…`). Modern Google hides this, so it is often empty — the
/// dashboard shows "(not provided)" in that case, exactly like GA.
fn keyword_from(referrer: &str) -> String {
    let q = match referrer.split_once('?') {
        Some((_, q)) => q,
        None => return String::new(),
    };
    let q = q.split('#').next().unwrap_or(q);
    for pair in q.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let kl = k.to_ascii_lowercase();
        if ["q", "query", "p", "text", "search", "keyword", "k"].contains(&kl.as_str()) {
            let v = url_decode(v);
            if !v.trim().is_empty() {
                return v;
            }
        }
    }
    String::new()
}

fn ref_host(referrer: &str) -> String {
    if referrer.trim().is_empty() {
        return "(direct)".to_string();
    }
    let s = referrer
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = s.split('/').next().unwrap_or(s).trim();
    if host.is_empty() {
        "(direct)".to_string()
    } else {
        host.to_string()
    }
}

fn day_label(day: i64) -> String {
    Utc.timestamp_opt(day * 86_400, 0)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn hour_label(hour: i64) -> String {
    Utc.timestamp_opt(hour * 3_600, 0)
        .single()
        .map(|d| d.format("%m-%d %H:00").to_string())
        .unwrap_or_default()
}

async fn health() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        "{\"status\":\"ok\",\"service\":\"analytics\"}",
    )
}

async fn beacon_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        BEACON_JS,
    )
        .into_response()
}

async fn world_svg() -> Response {
    (
        [(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")],
        WORLD_SVG,
    )
        .into_response()
}

fn cors(r: &mut Response) {
    r.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"),
    );
    r.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::HeaderValue::from_static("POST, OPTIONS"),
    );
    r.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::HeaderValue::from_static("content-type"),
    );
}

async fn collect_options() -> Response {
    let mut r = StatusCode::NO_CONTENT.into_response();
    cors(&mut r);
    r
}

async fn collect(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let cb: CollectBody = serde_json::from_slice(&body).unwrap_or_default();
    let refers = cb.refers;
    let keyword = keyword_from(&refers);
    let ev = Event {
        ts: now_ts(),
        path: if cb.path.is_empty() {
            "/".to_string()
        } else {
            cb.path
        },
        refers,
        country: country(&headers),
        visitor: visitor_id(&headers),
        site: if cb.site.is_empty() {
            state.site.clone()
        } else {
            cb.site
        },
        kind: if cb.kind.is_empty() {
            kind_pageview()
        } else {
            cb.kind
        },
        vid: stable_id(&headers),
        device: detect_device(&user_agent(&headers)),
        keyword,
        app: cb.app,
    };
    let is_pv = ev.kind != "heartbeat";

    if let Ok(mut v) = state.events.lock() {
        v.push(ev.clone());
        if v.len() > MAX_EVENTS {
            let over = v.len() - MAX_EVENTS;
            v.drain(0..over);
        }
    }
    if let Ok(mut guard) = state.file.lock() {
        if let Some(f) = guard.as_mut() {
            if let Ok(line) = serde_json::to_string(&ev) {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
        }
    }
    if let Ok(mut r) = state.rollups.lock() {
        r.add(&ev);
    }
    log("info", if is_pv { "pageview" } else { "heartbeat" });

    let mut r = StatusCode::NO_CONTENT.into_response();
    cors(&mut r);
    r
}

async fn dashboard(State(state): State<AppState>) -> Response {
    let html = if state.view == "app" { VIEW_HTML } else { DASHBOARD };
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Html(html),
    )
        .into_response()
}

async fn view_css() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        VIEW_CSS,
    )
        .into_response()
}

async fn view_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        VIEW_JS,
    )
        .into_response()
}

async fn app_css() -> Response {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        APP_CSS,
    )
        .into_response()
}

async fn app_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        APP_JS,
    )
        .into_response()
}

async fn summary(State(state): State<AppState>, Query(q): Query<SummaryQuery>) -> Response {
    let range = q.range.unwrap_or_else(|| "7d".to_string());
    let now = now_ts();
    let events = match state.events.lock() {
        Ok(v) => v.clone(),
        Err(_) => Vec::new(),
    };

    let hourly = range == "24h";
    let days = match range.as_str() {
        "30d" => 30,
        "24h" => 1,
        _ => 7,
    };

    let (buckets_n, start): (i64, i64) = if hourly {
        (24, now - 24 * 3_600)
    } else {
        (days, now - days * 86_400)
    };

    let mut total_pv: u64 = 0;
    let mut total_visitors: HashSet<String> = HashSet::new();
    let mut today_pv: u64 = 0;
    let mut today_visitors: HashSet<String> = HashSet::new();
    let mut live_pv: u64 = 0;
    let mut live_visitors: HashSet<String> = HashSet::new();
    let mut pages: HashMap<String, u64> = HashMap::new();
    let mut refs: HashMap<String, u64> = HashMap::new();
    let mut countries: HashMap<String, u64> = HashMap::new();
    let mut devices: HashMap<String, u64> = HashMap::new();
    let mut keywords: HashMap<String, u64> = HashMap::new();
    let mut new_vids: HashSet<String> = HashSet::new();
    let mut returning_vids: HashSet<String> = HashSet::new();
    // Per-app pageviews (historical) + per-app distinct active visitors (live).
    let mut apps: HashMap<String, u64> = HashMap::new();
    let mut live_apps: HashMap<String, HashSet<String>> = HashMap::new();

    // First-ever sighting of each stable visitor id (whole history), so we can
    // classify the range's visitors as new vs returning.
    let mut first_seen: HashMap<String, i64> = HashMap::new();
    for ev in &events {
        if ev.vid.is_empty() {
            continue;
        }
        let e = first_seen.entry(ev.vid.clone()).or_insert(ev.ts);
        if ev.ts < *e {
            *e = ev.ts;
        }
    }

    let today = now / 86_400;

    // series: (label, pageviews, visitors)
    let mut series: Vec<(String, u64, HashSet<String>)> = (0..buckets_n)
        .map(|i| {
            let idx = if hourly {
                (now / 3_600 - (buckets_n - 1 - i)) as i64
            } else {
                (today - (buckets_n - 1 - i)) as i64
            };
            let label = if hourly {
                hour_label(idx)
            } else {
                day_label(idx)
            };
            (label, 0u64, HashSet::new())
        })
        .collect();

    for ev in &events {
        let is_pv = ev.kind != "heartbeat";
        // Active users (GA-style): any event in the last 5 minutes, including
        // heartbeats, keeps a visitor "active" for the full window.
        if ev.ts >= now - 300 {
            live_visitors.insert(ev.visitor.clone());
            if is_pv {
                live_pv += 1;
            }
            if !ev.app.is_empty() {
                live_apps
                    .entry(ev.app.clone())
                    .or_default()
                    .insert(ev.visitor.clone());
            }
        }
        if ev.ts < start || !is_pv {
            continue;
        }
        total_pv += 1;
        total_visitors.insert(ev.visitor.clone());
        *pages.entry(ev.path.clone()).or_insert(0) += 1;
        if !ev.app.is_empty() {
            *apps.entry(ev.app.clone()).or_insert(0) += 1;
        }
        *refs.entry(ref_host(&ev.refers)).or_insert(0) += 1;
        if !ev.country.is_empty() {
            *countries.entry(ev.country.clone()).or_insert(0) += 1;
        }
        *devices
            .entry(if ev.device.is_empty() {
                "unknown".to_string()
            } else {
                ev.device.clone()
            })
            .or_insert(0) += 1;
        if !ev.keyword.is_empty() {
            *keywords.entry(ev.keyword.clone()).or_insert(0) += 1;
        }
        if !ev.vid.is_empty() {
            let fs = first_seen.get(&ev.vid).copied().unwrap_or(ev.ts);
            if fs >= start {
                new_vids.insert(ev.vid.clone());
            } else {
                returning_vids.insert(ev.vid.clone());
            }
        }
        if ev.ts / 86_400 == today {
            today_pv += 1;
            today_visitors.insert(ev.visitor.clone());
        }
        let idx = if hourly {
            (((ev.ts / 3_600) - (now / 3_600 - (buckets_n - 1))) as i64).clamp(0, buckets_n - 1)
        } else {
            ((ev.ts / 86_400) - (today - (buckets_n - 1))).clamp(0, buckets_n - 1)
        } as usize;
        series[idx].1 += 1;
        series[idx].2.insert(ev.visitor.clone());
    }

    let top = |m: &HashMap<String, u64>, n: usize| -> Vec<serde_json::Value> {
        let mut v: Vec<(String, u64)> = m.iter().map(|(k, c)| (k.clone(), *c)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.into_iter()
            .take(n)
            .map(|(k, c)| serde_json::json!({ "key": k, "count": c }))
            .collect()
    };

    let series_json: Vec<serde_json::Value> = series
        .iter()
        .map(|(label, pv, vis)| {
            serde_json::json!({ "t": label, "pageviews": pv, "visitors": vis.len() })
        })
        .collect();

    // Live per-app: distinct active visitors currently focused in each app.
    let mut live_apps_v: Vec<(String, usize)> =
        live_apps.iter().map(|(k, v)| (k.clone(), v.len())).collect();
    live_apps_v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let live_apps_json: Vec<serde_json::Value> = live_apps_v
        .into_iter()
        .map(|(k, c)| serde_json::json!({ "key": k, "count": c }))
        .collect();

    let body = serde_json::json!({
        "range": range,
        "site": state.site,
        "generated_at": Utc.timestamp_opt(now, 0).single().map(|d| d.to_rfc3339()).unwrap_or_default(),
        "total": { "pageviews": total_pv, "visitors": total_visitors.len() },
        "today": { "pageviews": today_pv, "visitors": today_visitors.len() },
        "live": {
            "window_seconds": 300,
            "pageviews": live_pv,
            "visitors": live_visitors.len(),
            "apps": live_apps_json,
        },
        "series": series_json,
        "top_pages": top(&pages, 10),
        "top_apps": top(&apps, 12),
        "top_referrers": top(&refs, 10),
        "top_countries": top(&countries, 12),
        "devices": top(&devices, 6),
        "new_vs_returning": {
            "new": new_vids.len(),
            "returning": returning_vids.len()
        },
        "top_keywords": top(&keywords, 10),
    });

    (
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

#[derive(Deserialize)]
struct SeriesQuery {
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    to: Option<i64>,
    #[serde(default)]
    buckets: Option<usize>,
}

/// "Nice" bucket steps, seconds — powers of seconds and minutes up to a day.
/// The query picks the smallest step whose on-screen bucket count stays within
/// the requested budget, so zooming never fetches an unbounded number of points.
const STEP_LADDER: [i64; 16] = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 86400,
];

fn choose_step(span: i64, buckets: usize) -> i64 {
    let ideal = span.max(1) as f64 / buckets.max(1) as f64;
    for s in STEP_LADDER {
        if s as f64 >= ideal {
            return s;
        }
    }
    86_400
}

#[derive(Serialize)]
struct Point {
    /// Bucket start, unix seconds.
    t: i64,
    /// Distinct visitors active inside the bucket (the "heartbeat" spikes).
    users: u64,
    events: u64,
    pv: u64,
    /// Presence-derived concurrent users at the bucket (sliding window); only
    /// computed from raw events (fine zoom), `null` at coarse resolutions.
    #[serde(skip_serializing_if = "Option::is_none")]
    concurrent: Option<u64>,
}

fn series_from_rollup(
    roll: &BTreeMap<i64, Agg>,
    origin: i64,
    step: i64,
    n: usize,
    base: i64,
) -> Vec<Point> {
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = origin + i as i64 * step;
        let k0 = t / base;
        let k1 = (t + step - 1) / base;
        let mut users: HashSet<&str> = HashSet::new();
        let mut events = 0u64;
        let mut pv = 0u64;
        for (_, a) in roll.range(k0..=k1) {
            events += a.events;
            pv += a.pv;
            for u in &a.users {
                users.insert(u.as_str());
            }
        }
        out.push(Point {
            t,
            users: users.len() as u64,
            events,
            pv,
            concurrent: None,
        });
    }
    out
}

fn series_from_raw(
    evs: &[Event],
    origin: i64,
    step: i64,
    n: usize,
    presence: i64,
) -> Vec<Point> {
    let end = origin + n as i64 * step;
    let mut sets: Vec<HashSet<&str>> = (0..n).map(|_| HashSet::new()).collect();
    let mut ev_count = vec![0u64; n];
    let mut pv_count = vec![0u64; n];
    for ev in evs {
        if ev.ts < origin || ev.ts >= end {
            continue;
        }
        let idx = ((ev.ts - origin) / step) as usize;
        if idx >= n {
            continue;
        }
        ev_count[idx] += 1;
        if ev.kind != "heartbeat" {
            pv_count[idx] += 1;
        }
        if !ev.visitor.is_empty() {
            sets[idx].insert(ev.visitor.as_str());
        }
    }

    // Concurrent users: one sliding-window pass. Window for bucket i is
    // [t - presence, t + step); both ends move forward monotonically, so a
    // two-pointer sweep with a distinct-count map is linear.
    let mut counts: HashMap<&str, u32> = HashMap::new();
    let mut active = 0usize;
    let mut left = 0usize;
    let mut right = 0usize;
    let mut conc = vec![0u64; n];
    for i in 0..n {
        let b = origin + i as i64 * step;
        let wl = b - presence;
        let wr = b + step;
        while right < evs.len() && evs[right].ts < wr {
            let v = evs[right].visitor.as_str();
            if !v.is_empty() {
                let e = counts.entry(v).or_insert(0);
                if *e == 0 {
                    active += 1;
                }
                *e += 1;
            }
            right += 1;
        }
        while left < right && evs[left].ts < wl {
            let v = evs[left].visitor.as_str();
            if !v.is_empty() {
                if let Some(e) = counts.get_mut(v) {
                    if *e > 0 {
                        *e -= 1;
                    }
                    if *e == 0 {
                        active = active.saturating_sub(1);
                    }
                }
            }
            left += 1;
        }
        conc[i] = active as u64;
    }

    (0..n)
        .map(|i| Point {
            t: origin + i as i64 * step,
            users: sets[i].len() as u64,
            events: ev_count[i],
            pv: pv_count[i],
            concurrent: Some(conc[i]),
        })
        .collect()
}

/// Zoomable traffic series for the dashboard chart. `?from&to&buckets` returns
/// ~`buckets` points over `[from, to]` (max 30 days); the server picks a nice
/// step and answers from the finest rollup that covers the window (raw events
/// for sub-minute zoom, minute/hour/day rollups above). Used by the app-view
/// chart's wheel-zoom / drag-pan interaction.
async fn series(State(state): State<AppState>, Query(q): Query<SeriesQuery>) -> Response {
    let now = now_ts();
    let to = q.to.unwrap_or(now).min(now);
    let max_span = 30 * 86_400;
    let mut from = q.from.unwrap_or(to - 86_400);
    if to - from > max_span {
        from = to - max_span;
    }
    if from >= to {
        from = to - 1;
    }
    let buckets = q.buckets.unwrap_or(160).clamp(8, 400);
    let step = choose_step(to - from, buckets);
    let base = if step >= 86_400 {
        86_400
    } else if step >= 3_600 {
        3_600
    } else if step >= 60 {
        60
    } else {
        1
    };
    // Align the grid to the rollup base so merged buckets are exact.
    let origin = if base > 1 { from.div_euclid(base) * base } else { from };
    let n = ((((to - origin).max(1) + step - 1) / step) as usize).clamp(1, buckets + 2);
    let end = origin + n as i64 * step;

    let points = if base == 1 {
        match state.events.lock() {
            Ok(evs) => {
                let lo = evs.partition_point(|e| e.ts < origin - PRESENCE);
                let hi = evs.partition_point(|e| e.ts < end);
                series_from_raw(&evs[lo..hi], origin, step, n, PRESENCE)
            }
            Err(_) => Vec::new(),
        }
    } else {
        match state.rollups.lock() {
            Ok(r) => {
                let roll = match base {
                    86_400 => &r.day,
                    3_600 => &r.hour,
                    _ => &r.minute,
                };
                series_from_rollup(roll, origin, step, n, base)
            }
            Err(_) => Vec::new(),
        }
    };

    let body = serde_json::json!({
        "from": origin,
        "to": to,
        "step": step,
        "points": points,
    });
    (
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// Public, minimal aggregate for lightweight widgets (e.g. the OS footer):
/// just counts over a range — no pages, referrers, keywords, or countries.
async fn public_stats(State(state): State<AppState>, Query(q): Query<SummaryQuery>) -> Response {
    let range = q.range.unwrap_or_else(|| "24h".to_string());
    let now = now_ts();
    let hours: i64 = match range.as_str() {
        "7d" => 7 * 24,
        "30d" => 30 * 24,
        _ => 24,
    };
    let start = now - hours * 3_600;
    let events = match state.events.lock() {
        Ok(v) => v.clone(),
        Err(_) => Vec::new(),
    };
    let mut views: u64 = 0;
    let mut visitors: HashSet<String> = HashSet::new();
    let mut active: HashSet<String> = HashSet::new();
    for ev in &events {
        if ev.kind == "pageview" && ev.ts >= start {
            views += 1;
            if !ev.vid.is_empty() {
                visitors.insert(ev.vid.clone());
            }
        }
        if !ev.vid.is_empty() && ev.ts >= now - 300 {
            active.insert(ev.vid.clone());
        }
    }
    let body = serde_json::json!({
        "range": range,
        "views": views,
        "visitors": visitors.len(),
        "active": active.len(),
    })
    .to_string();
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

fn load_events(path: &PathBuf, events: &Arc<Mutex<Vec<Event>>>) -> (usize, Rollups) {
    let mut rollups = Rollups::default();
    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, rollups),
    };
    let mut guard = match events.lock() {
        Ok(g) => g,
        Err(_) => return (0, rollups),
    };
    let mut n = 0usize;
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(ev) = serde_json::from_str::<Event>(&line) {
            rollups.add(&ev);
            guard.push(ev);
            n += 1;
        }
    }
    (n, rollups)
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4300);
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".into()));
    let site = std::env::var("SITE").unwrap_or_else(|_| "default".into());
    // `VIEW=app` serves the app-centric, self-contained dashboard; anything
    // else (default) keeps the estate marketing dashboard.
    let view = std::env::var("VIEW")
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let view = if view == "app" { "app".to_string() } else { "default".to_string() };

    let _ = fs::create_dir_all(&data_dir);
    let events_path = data_dir.join("events.ndjson");
    let events = Arc::new(Mutex::new(Vec::new()));
    let (loaded, rollups) = load_events(&events_path, &events);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .ok();

    let state = AppState {
        events,
        file: Arc::new(Mutex::new(file)),
        rollups: Arc::new(Mutex::new(rollups)),
        site,
        view,
    };

    let app = Router::new()
        .route("/", get(dashboard))
        .route("/analytics-app", get(dashboard))
        .route("/analytics-app/", get(dashboard))
        .route("/analytics-app/static/app.css", get(app_css))
        .route("/analytics-app/static/app.js", get(app_js))
        .route("/analytics-app/static/world.svg", get(world_svg))
        .route("/analytics-app/static/view.css", get(view_css))
        .route("/analytics-app/static/view.js", get(view_js))
        .route("/analytics-app/api/summary", get(summary))
        .route("/analytics-app/api/series", get(series))
        .route("/analytics-app/api/health", get(health))
        .route("/analytics-beacon/a.js", get(beacon_js))
        .route("/analytics-beacon/collect", post(collect).options(collect_options))
        .route("/analytics-beacon/health", get(health))
        .route("/analytics-beacon/stats", get(public_stats))
        // standalone aliases (local dev / direct)
        .route("/static/app.css", get(app_css))
        .route("/static/app.js", get(app_js))
        .route("/static/view.css", get(view_css))
        .route("/static/view.js", get(view_js))
        .route("/api/summary", get(summary))
        .route("/api/series", get(series))
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("analytics could not bind its port");
    log("info", &format!("analytics listening on {addr} ({loaded} events loaded)"));
    axum::serve(listener, app)
        .await
        .expect("analytics stopped unexpectedly");
}
