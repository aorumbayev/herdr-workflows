//! Port of `test/web-server.test.ts`: token/host gating, parse→format
//! round-trip, write validation, promote 409, validation parity with the CLI
//! load path, and the `page.html` byte-identity pin.
//!
//! Raw HTTP over `TcpStream` — no HTTP-client crate for localhost JSON tests.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

use herdr_workflows::web::{PAGE_HTML, WebOptions, WebServer, start_web_server};
use herdr_workflows::workflow::discover::WorkflowDirs;
use herdr_workflows::workflow::load::parse_workflow_text;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("hwf-web-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A repo root with `.hwf/config.yaml` + empty workflows dir (TS `repo()`).
fn repo() -> TempDir {
    let root = TempDir::new("repo");
    let dir = root.path().join(".hwf").join("workflows");
    std::fs::create_dir_all(&dir).expect("workflows dir");
    std::fs::write(
        root.path().join(".hwf").join("config.yaml"),
        "agents:\n  claude: [claude, '{prompt}']\n",
    )
    .expect("config");
    root
}

fn serve(root: &Path) -> WebServer {
    start_web_server(&WebOptions::new(root)).expect("start web server")
}

struct HttpResponse {
    status: u16,
    body: String,
}

impl HttpResponse {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).expect("response body is JSON")
    }
}

/// One blocking HTTP/1.1 exchange with `Connection: close`.
fn http(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> HttpResponse {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        request.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        request.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
    stream.write_all(request.as_bytes()).expect("write request");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read response");
    let (head, body) = raw.split_once("\r\n\r\n").expect("header/body split");
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("status code in status line");
    HttpResponse {
        status,
        body: body.to_string(),
    }
}

fn api(port: u16, token: &str, method: &str, path: &str, body: Option<&str>) -> HttpResponse {
    let headers: Vec<(&str, &str)> = if body.is_some() {
        vec![("x-hwf-token", token), ("content-type", "application/json")]
    } else {
        vec![("x-hwf-token", token)]
    };
    http(port, method, path, &headers, body)
}

// --- web server security -------------------------------------------------

#[test]
fn missing_token_rejected() {
    let root = repo();
    let server = serve(root.path());
    let res = http(server.port(), "GET", "/api/state", &[], None);
    assert_eq!(res.status, 403);
}

#[test]
fn foreign_origin_rejected() {
    let root = repo();
    let server = serve(root.path());
    let res = http(
        server.port(),
        "GET",
        "/api/state",
        &[
            ("x-hwf-token", server.token()),
            ("origin", "http://evil.example.com"),
        ],
        None,
    );
    assert_eq!(res.status, 403);
}

#[test]
fn bogus_host_rejected() {
    let root = repo();
    let server = serve(root.path());
    let res = http(
        server.port(),
        "GET",
        "/api/state",
        &[("x-hwf-token", server.token()), ("host", "10.0.0.9:9000")],
        None,
    );
    assert_eq!(res.status, 403);
}

#[test]
fn valid_token_and_host_serves_state() {
    let root = repo();
    let server = serve(root.path());
    let res = api(server.port(), server.token(), "GET", "/api/state", None);
    assert_eq!(res.status, 200);
    let body = res.json();
    let agents = body["agents"].as_array().expect("agents array");
    assert!(agents.contains(&serde_json::json!("claude")));
}

#[test]
fn index_requires_query_token_and_serves_page_with_token_injected() {
    let root = repo();
    let server = serve(root.path());
    let denied = http(server.port(), "GET", "/", &[], None);
    assert_eq!(denied.status, 403);
    let page = http(
        server.port(),
        "GET",
        &format!("/?token={}", server.token()),
        &[],
        None,
    );
    assert_eq!(page.status, 200);
    assert!(
        page.body.contains(server.token()),
        "__HWF_TOKEN__ must be replaced by the per-launch token"
    );
    assert!(!page.body.contains("__HWF_TOKEN__"));
}

#[test]
fn workflow_get_rejects_path_traversal_names() {
    let root = repo();
    let server = serve(root.path());
    let res = api(
        server.port(),
        server.token(),
        "GET",
        "/api/workflow?name=..%2F..%2F..%2F.hwf%2Fconfig&scope=repo",
        None,
    );
    assert_eq!(res.status, 400);
}

#[test]
fn unknown_api_route_is_404() {
    let root = repo();
    let server = serve(root.path());
    let res = api(server.port(), server.token(), "GET", "/api/nope", None);
    assert_eq!(res.status, 404);
    let outside = http(
        server.port(),
        "GET",
        "/favicon.ico",
        &[("x-hwf-token", server.token())],
        None,
    );
    assert_eq!(outside.status, 404);
}

// --- web visual round-trip -----------------------------------------------

#[test]
fn parse_then_format_returns_readable_yaml() {
    let root = repo();
    let server = serve(root.path());
    let yaml =
        "steps:\n  - shell: echo hi\n    stdin: '{pane}'\n  - agent: claude\n    prompt: go\n";
    let parsed = api(
        server.port(),
        server.token(),
        "POST",
        "/api/parse",
        Some(&serde_json::json!({"text": yaml}).to_string()),
    );
    assert_eq!(parsed.json()["ok"], true);
    let doc = parsed.json()["doc"].clone();
    let formatted = api(
        server.port(),
        server.token(),
        "POST",
        "/api/format",
        Some(&serde_json::json!({"doc": doc}).to_string()),
    );
    assert_eq!(formatted.json()["ok"], true);
    let body = formatted.json();
    let text = body["text"].as_str().expect("text");
    assert!(text.contains("stdin: \"{pane}\""), "got: {text}");
    assert!(text.contains("\n\n  - agent: claude"), "got: {text}");
}

#[test]
fn format_rejects_a_doc_with_no_steps() {
    let root = repo();
    let server = serve(root.path());
    let res = api(
        server.port(),
        server.token(),
        "POST",
        "/api/format",
        Some(&serde_json::json!({"doc": {"steps": []}}).to_string()),
    );
    assert_eq!(res.json()["ok"], false);
}

// --- web server writes ----------------------------------------------------

#[test]
fn validate_does_not_write() {
    let root = repo();
    let server = serve(root.path());
    let res = api(
        server.port(),
        server.token(),
        "POST",
        "/api/validate",
        Some(
            &serde_json::json!({"name": "buf", "text": "steps:\n  - shell: echo hi\n"}).to_string(),
        ),
    );
    assert_eq!(res.json()["ok"], true);
    assert!(!root.path().join(".hwf/workflows/buf.yaml").exists());
}

#[test]
fn invalid_save_rejected_not_written() {
    let root = repo();
    let server = serve(root.path());
    let res = api(
        server.port(),
        server.token(),
        "PUT",
        "/api/workflow",
        Some(
            &serde_json::json!({"name": "bad", "scope": "repo", "text": "steps:\n  - shell: echo {pane}\n"})
                .to_string(),
        ),
    );
    let body = res.json();
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().expect("error");
    assert!(error.contains("step 1"), "got: {error}");
    assert!(!root.path().join(".hwf/workflows/bad.yaml").exists());
}

#[test]
fn validate_error_matches_cli_load_path_byte_for_byte() {
    let root = repo();
    let server = serve(root.path());
    let text = "steps:\n  - shell: echo {pane}\n";
    let res = api(
        server.port(),
        server.token(),
        "POST",
        "/api/validate",
        Some(&serde_json::json!({"name": "bad", "text": text}).to_string()),
    );
    assert_eq!(res.status, 400);
    let via_http = res.json()["error"].as_str().expect("error").to_string();

    let mut agents = std::collections::HashSet::new();
    agents.insert("claude".to_string());
    let dirs = WorkflowDirs::for_repo(root.path());
    let via_cli = parse_workflow_text("bad", text, &agents, &dirs, "bad.yaml", true)
        .expect_err("must fail")
        .to_string();
    assert_eq!(via_http, via_cli);
}

#[test]
fn valid_save_writes() {
    let root = repo();
    let server = serve(root.path());
    let res = api(
        server.port(),
        server.token(),
        "PUT",
        "/api/workflow",
        Some(
            &serde_json::json!({"name": "good", "scope": "repo", "text": "steps:\n  - shell: echo hi\n"})
                .to_string(),
        ),
    );
    assert_eq!(res.json()["ok"], true);
    assert!(root.path().join(".hwf/workflows/good.yaml").exists());
}

// `env::set_var` is unsafe in Rust 2024 and this crate forbids unsafe code,
// so tests that need an isolated global scope pass `WebOptions.home` instead
// of mutating `HOME` (same pattern as `runner::runlog::RunLog::new`).

#[test]
fn promote_refuses_clobber_without_force_overwrites_with_force() {
    let root = repo();
    std::fs::write(
        root.path().join(".hwf/workflows/shared.yaml"),
        "steps:\n  - shell: echo repo\n",
    )
    .expect("repo workflow");
    let home = TempDir::new("home");
    std::fs::create_dir_all(home.path().join(".hwf/workflows")).expect("global dir");
    let global_file = home.path().join(".hwf/workflows/shared.yaml");
    std::fs::write(&global_file, "steps:\n  - shell: echo global\n").expect("global workflow");

    let server = start_web_server(&WebOptions {
        repo_root: root.path().to_path_buf(),
        port: None,
        token: None,
        home: Some(home.path().to_path_buf()),
    })
    .expect("start web server");
    let call = |force: Option<bool>| {
        let mut body = serde_json::json!({"name": "shared", "from": "repo", "to": "global"});
        if let Some(force) = force {
            body["force"] = serde_json::json!(force);
        }
        api(
            server.port(),
            server.token(),
            "POST",
            "/api/promote",
            Some(&body.to_string()),
        )
    };
    let clobber = call(None);
    assert_eq!(clobber.status, 409);
    assert_eq!(clobber.json()["error"], "'shared' already exists in global");
    assert!(
        std::fs::read_to_string(&global_file)
            .expect("global file")
            .contains("global")
    );
    let forced = call(Some(true));
    assert_eq!(forced.json()["ok"], true);
    assert!(
        std::fs::read_to_string(&global_file)
            .expect("global file")
            .contains("repo")
    );
}

#[test]
fn promote_missing_source_is_404() {
    let root = repo();
    let home = TempDir::new("home");
    let server = start_web_server(&WebOptions {
        repo_root: root.path().to_path_buf(),
        port: None,
        token: None,
        home: Some(home.path().to_path_buf()),
    })
    .expect("start web server");
    let res = api(
        server.port(),
        server.token(),
        "POST",
        "/api/promote",
        Some(&serde_json::json!({"name": "ghost", "from": "global", "to": "repo"}).to_string()),
    );
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["error"], "source not found");
}

#[test]
fn runs_returns_a_runs_array() {
    // Content shape is covered by `runner::runlog` unit tests; the web layer
    // only proves the route wires `RunLog::from_env` through. The log read is
    // read-only, so no state-dir isolation is needed here.
    let root = repo();
    let server = serve(root.path());
    let res = api(server.port(), server.token(), "GET", "/api/runs", None);
    assert_eq!(res.status, 200);
    assert!(res.json()["runs"].is_array());
}

// --- page.html byte identity ----------------------------------------------

/// FNV-1a 64 of the embedded page, pinned when `src/web/page.html` was copied
/// to `rust/src/web/page.html` (the TS tree is deleted in P4).
#[test]
fn page_html_is_byte_identical_to_the_ts_source() {
    const EXPECTED_LEN: usize = 34_294;
    const EXPECTED_FNV1A: u64 = 0xf8f0_20d6_77ef_f8df;
    assert_eq!(PAGE_HTML.len(), EXPECTED_LEN);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in PAGE_HTML.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    assert_eq!(hash, EXPECTED_FNV1A, "page.html drifted from the TS source");
    assert!(PAGE_HTML.contains("__HWF_TOKEN__"));
}

// --- port auto-increment ---------------------------------------------------

#[test]
fn auto_ports_start_at_7317_and_never_collide() {
    // Parallel tests interleave the 7317+ scan, so exact +1 spacing is not
    // assertable here; what must hold is the floor and no collision between
    // two live servers.
    let root = repo();
    let first = serve(root.path());
    let second = serve(root.path());
    assert!(first.port() >= 7317);
    assert!(second.port() >= 7317);
    assert_ne!(first.port(), second.port());
}

#[test]
fn pinned_port_conflict_fails_instead_of_incrementing() {
    let root = repo();
    let first = serve(root.path());
    let result = start_web_server(&WebOptions {
        repo_root: root.path().to_path_buf(),
        port: Some(first.port()),
        token: None,
        home: None,
    });
    let Err(err) = result else {
        panic!("pinned port in use must fail");
    };
    assert!(err.to_string().to_lowercase().contains("in use"));
}
