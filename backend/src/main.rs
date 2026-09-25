//! analytics — privacy-first traffic analytics LXS.
//!
//! v0.1 sources: a first-party, cookieless **pageview beacon** (`a.js` +
//! `POST /analytics-beacon/collect`). Events are appended to an NDJSON log and
//! kept in memory for fast aggregation. The dashboard + JSON API are meant to
//! sit behind the estate gateway at `role:superadmin`.
//!
//! Future sources (Cloudflare zone/RUM, GA4) plug into the same store.

use std::collections::{HashMap, HashSet};
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

const MAX_EVENTS: usize = 500_000;

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
}

#[derive(Clone)]
struct AppState {
    events: Arc<Mutex<Vec<Event>>>,
    file: Arc<Mutex<Option<File>>>,
    site: String,
}

#[derive(Default, Deserialize)]
struct CollectBody {
    #[serde(default)]
    site: String,
    #[serde(default, alias = "p")]
    path: String,
    #[serde(default, alias = "r", alias = "referrer")]
    refers: String,
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
    let ev = Event {
        ts: now_ts(),
        path: if cb.path.is_empty() {
            "/".to_string()
        } else {
            cb.path
        },
        refers: cb.refers,
        country: country(&headers),
        visitor: visitor_id(&headers),
        site: if cb.site.is_empty() {
            state.site.clone()
        } else {
            cb.site
        },
    };

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
    log("info", "pageview");

    let mut r = StatusCode::NO_CONTENT.into_response();
    cors(&mut r);
    r
}

async fn dashboard() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Html(DASHBOARD),
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
        if ev.ts < start {
            continue;
        }
        total_pv += 1;
        total_visitors.insert(ev.visitor.clone());
        *pages.entry(ev.path.clone()).or_insert(0) += 1;
        *refs.entry(ref_host(&ev.refers)).or_insert(0) += 1;
        if !ev.country.is_empty() {
            *countries.entry(ev.country.clone()).or_insert(0) += 1;
        }
        if ev.ts / 86_400 == today {
            today_pv += 1;
            today_visitors.insert(ev.visitor.clone());
        }
        if ev.ts >= now - 300 {
            live_pv += 1;
            live_visitors.insert(ev.visitor.clone());
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

    let body = serde_json::json!({
        "range": range,
        "site": state.site,
        "generated_at": Utc.timestamp_opt(now, 0).single().map(|d| d.to_rfc3339()).unwrap_or_default(),
        "total": { "pageviews": total_pv, "visitors": total_visitors.len() },
        "today": { "pageviews": today_pv, "visitors": today_visitors.len() },
        "live": { "window_seconds": 300, "pageviews": live_pv, "visitors": live_visitors.len() },
        "series": series_json,
        "top_pages": top(&pages, 10),
        "top_referrers": top(&refs, 10),
        "top_countries": top(&countries, 10),
    });

    (
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn load_events(path: &PathBuf, events: &Arc<Mutex<Vec<Event>>>) -> usize {
    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let mut guard = match events.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let mut n = 0usize;
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(ev) = serde_json::from_str::<Event>(&line) {
            guard.push(ev);
            n += 1;
        }
    }
    n
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4300);
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".into()));
    let site = std::env::var("SITE").unwrap_or_else(|_| "default".into());

    let _ = fs::create_dir_all(&data_dir);
    let events_path = data_dir.join("events.ndjson");
    let events = Arc::new(Mutex::new(Vec::new()));
    let loaded = load_events(&events_path, &events);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .ok();

    let state = AppState {
        events,
        file: Arc::new(Mutex::new(file)),
        site,
    };

    let app = Router::new()
        .route("/", get(dashboard))
        .route("/analytics-app", get(dashboard))
        .route("/analytics-app/", get(dashboard))
        .route("/analytics-app/static/app.css", get(app_css))
        .route("/analytics-app/static/app.js", get(app_js))
        .route("/analytics-app/api/summary", get(summary))
        .route("/analytics-app/api/health", get(health))
        .route("/analytics-beacon/a.js", get(beacon_js))
        .route("/analytics-beacon/collect", post(collect).options(collect_options))
        .route("/analytics-beacon/health", get(health))
        // standalone aliases (local dev / direct)
        .route("/static/app.css", get(app_css))
        .route("/static/app.js", get(app_js))
        .route("/api/summary", get(summary))
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
