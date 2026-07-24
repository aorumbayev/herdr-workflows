//! `tiny_http` server with token/host gating, plus the `cmdWeb`/`openBrowser`
//! parts of `src/cli.ts`. Port of `src/web/server.ts` (design D3: no async,
//! single-threaded accept loop on one handler thread).

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{Map, Value};
use tiny_http::{Header, ListenAddr, Method, Request, Response, Server};

use crate::workflow::discover::{WorkflowDirs, global_dir};

use super::routes::{self, JsonResponse, Outcome};
use super::routes_files;

/// The workbench SPA, embedded byte-identical to `src/web/page.html`
/// (byte-identity is pinned in `rust/tests/web_server.rs`).
pub const PAGE_HTML: &str = include_str!("page.html");

/// Constructor inputs for [`start_web_server`] — TS `startWebServer(opts)`.
#[derive(Debug, Clone)]
pub struct WebOptions {
    pub repo_root: PathBuf,
    /// Fixed port; `None` auto-increments from 7317 until a bind succeeds.
    pub port: Option<u16>,
    /// Fixed token; `None` generates a fresh uuid v4 per launch.
    pub token: Option<String>,
    /// Home directory override for the global scope (`~/.hwf/workflows`).
    /// `None` reads `HOME` like the TS default; tests inject a temp dir
    /// because `env::set_var` is unsafe in Rust 2024 and this crate forbids
    /// unsafe code.
    pub home: Option<PathBuf>,
}

impl WebOptions {
    #[must_use]
    pub fn new(repo_root: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            port: None,
            token: None,
            home: None,
        }
    }
}

/// A running server — TS `WebServer`. Dropping stops the handler thread.
pub struct WebServer {
    url: String,
    token: String,
    port: u16,
    server: Arc<Server>,
    running: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl WebServer {
    /// `http://127.0.0.1:<port>/?token=<token>`.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stop the handler thread and release the port.
    pub fn stop(self) {}

    fn shutdown(&self) {
        self.running.store(false, Ordering::Relaxed);
        self.server.unblock();
        if let Some(thread) = self.thread.lock().expect("thread handle mutex").take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WebServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct HandlerState {
    dirs: WorkflowDirs,
    token: String,
    port: u16,
}

/// `WorkflowDirs` for the server: explicit repo root, global workflows under
/// `opts.home` when set (tests) else `HOME` (TS default).
fn dirs_of(opts: &WebOptions) -> WorkflowDirs {
    WorkflowDirs {
        repo_root: opts.repo_root.clone(),
        global: opts
            .home
            .as_ref()
            .map_or_else(global_dir, |home| home.join(".hwf").join("workflows")),
    }
}

/// Bind 127.0.0.1 (auto-incrementing from 7317 unless `opts.port` pins one)
/// and serve the workbench routes on a single handler thread.
///
/// # Errors
/// Returns the bind failure when `opts.port` is pinned and unavailable, or
/// when port auto-increment exhausts the u16 range.
pub fn start_web_server(opts: &WebOptions) -> std::io::Result<WebServer> {
    let token = opts
        .token
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut port = opts.port.unwrap_or(7317);
    let server = loop {
        match Server::http((Ipv4Addr::LOCALHOST, port)) {
            Ok(server) => break server,
            Err(e) => {
                let in_use = e.to_string().to_lowercase().contains("in use");
                if opts.port.is_none() && in_use {
                    port = port
                        .checked_add(1)
                        .ok_or_else(|| std::io::Error::other("no free port from 7317 upward"))?;
                } else {
                    return Err(std::io::Error::other(e));
                }
            }
        }
    };
    let bound_port = match server.server_addr() {
        ListenAddr::IP(addr) => addr.port(),
        #[cfg(unix)]
        ListenAddr::Unix(_) => port,
    };
    let server = Arc::new(server);
    let running = Arc::new(AtomicBool::new(true));
    let thread = {
        let server = Arc::clone(&server);
        let running = Arc::clone(&running);
        let state = Arc::new(HandlerState {
            dirs: dirs_of(opts),
            token: token.clone(),
            port: bound_port,
        });
        std::thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                match server.recv() {
                    Ok(request) => handle_request(&state, request),
                    Err(_) => break,
                }
            }
        })
    };
    Ok(WebServer {
        url: format!("http://127.0.0.1:{bound_port}/?token={token}"),
        token,
        port: bound_port,
        server,
        running,
        thread: Mutex::new(Some(thread)),
    })
}

/// CLI `web` entry (`cmdWeb`): start, print the URL, open a browser unless
/// `no_open`, then serve until the process is killed.
///
/// # Errors
/// Propagates the bind failure from [`start_web_server`].
pub fn serve(repo_root: &Path, port: Option<u16>, no_open: bool) -> std::io::Result<()> {
    let server = start_web_server(&WebOptions {
        repo_root: repo_root.to_path_buf(),
        port,
        token: None,
        home: None,
    })?;
    println!("herdr-workflows web · {}", server.url());
    if !no_open {
        open_browser(server.url());
    }
    loop {
        std::thread::park();
    }
}

/// Best-effort browser launch — TS `openBrowser` minus the Windows branch
/// (Windows is a product non-goal). Failure is ignored: the printed URL
/// still works.
fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return;
    let _ = Command::new(program)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn handle_request(state: &HandlerState, mut request: Request) {
    let response = route(state, &mut request);
    let _ = request.respond(response);
}

fn route(state: &HandlerState, request: &mut Request) -> Response<std::io::Cursor<Vec<u8>>> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(url.as_str());
    let query = url.split_once('?').map_or("", |(_, q)| q);
    let method = request.method().clone();

    if !host_allowed(header(request, "host"), state.port) {
        return plain(403, "forbidden");
    }
    if let Some(origin) = header(request, "origin") {
        if !host_allowed(Some(origin), state.port) {
            return plain(403, "forbidden");
        }
    }

    if path == "/" {
        if query_param(query, "token").as_deref() != Some(state.token.as_str()) {
            return plain(403, "forbidden");
        }
        return html(PAGE_HTML.replacen("__HWF_TOKEN__", &state.token, 1));
    }

    if !path.starts_with("/api/") {
        return plain(404, "not found");
    }
    if header(request, "x-hwf-token") != Some(state.token.as_str()) {
        return plain(403, "forbidden");
    }

    let body = if method == Method::Get {
        Value::Object(Map::new())
    } else {
        let mut text = String::new();
        let _ = request.as_reader().read_to_string(&mut text);
        serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Map::new()))
    };

    let outcome = match path {
        "/api/state" => routes::get_state(&state.dirs).map(Outcome::from),
        "/api/workflow" => routes_files::handle_workflow(&state.dirs, &method, query, &body),
        "/api/parse" if method == Method::Post => Ok(routes::handle_parse(&body).into()),
        "/api/format" if method == Method::Post => Ok(routes::handle_format(&body).into()),
        "/api/validate" if method == Method::Post => {
            routes::handle_validate(&state.dirs, &body).map(Outcome::from)
        }
        "/api/promote" if method == Method::Post => {
            routes_files::handle_promote(&state.dirs, &body)
        }
        "/api/config" => routes_files::handle_config(&state.dirs, &method, query, &body),
        "/api/runs" if method == Method::Get => Ok(routes::handle_runs().into()),
        _ => return plain(404, "not found"),
    };
    match outcome {
        Ok(Outcome::Json(response)) => json_response(&response),
        Ok(Outcome::Text { status, body }) => plain(status, body),
        Err(error) => json_response(&JsonResponse::err(500, error)),
    }
}

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

/// Accept the bound host and its `localhost` alias, with or without the port.
fn host_allowed(value: Option<&str>, port: u16) -> bool {
    let Some(value) = value else {
        return false;
    };
    let host = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or(value);
    host == format!("127.0.0.1:{port}")
        || host == format!("localhost:{port}")
        || host == "127.0.0.1"
        || host == "localhost"
}

/// First value of a query parameter, percent-decoded (`+` → space, matching
/// `URLSearchParams`).
pub(crate) fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode(k) == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn content_type(value: &'static str) -> Header {
    Header::from_bytes("content-type", value).expect("static ASCII header parts")
}

fn plain(status: u16, body: &'static str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_status_code(status)
}

fn html(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_header(content_type("text/html; charset=utf-8"))
}

fn json_response(response: &JsonResponse) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(response.body.to_string())
        .with_status_code(response.status)
        .with_header(content_type("application/json"))
}
