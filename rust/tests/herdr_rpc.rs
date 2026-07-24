//! Ported assertions from `test/rpc.test.ts` and `test/wait-output.test.ts`.
//! Sockets are real `UnixListener`s on temp paths and the "herdr binary" is
//! an `sh` script recording argv — no live herdr, no env mutation (the
//! `_at`/`_with` seams exist for exactly this).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};

use herdr_workflows::herdr::cli::wait_output_with;
use herdr_workflows::herdr::rpc::{herdr_call_at, herdr_request_at};
use serde_json::{Value, json};

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        // Unix socket paths are SUN_LEN-limited; keep the dir short.
        let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let path = PathBuf::from(format!("/tmp/hwf-{tag}-{short}"));
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

/// Bind a listener and run `serve` on a thread with the accepted stream.
fn with_server(
    serve: impl FnOnce(std::os::unix::net::UnixStream) + Send + 'static,
) -> (TempDir, PathBuf) {
    let dir = TempDir::new("rpc");
    let sock = dir.0.join("herdr.sock");
    let listener = UnixListener::bind(&sock).expect("bind");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        serve(stream);
    });
    (dir, sock)
}

#[test]
fn rejects_when_socket_closes_without_response() {
    let (_dir, sock) = with_server(drop);
    let err = herdr_request_at(
        &sock,
        "layout.apply",
        &json!({}).as_object().expect("o").clone(),
    )
    .expect_err("closed before response");
    assert_eq!(err.code, "closed");
    assert!(err.message.contains("layout.apply"));
}

#[test]
fn request_shape_and_result_unwrap() {
    let (_dir, sock) = with_server(|mut stream| {
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).expect("read");
        let request: Value = serde_json::from_str(line.trim()).expect("request json");
        let id = request["id"].as_str().expect("id").to_string();
        assert!(id.starts_with("herdr-workflows:"));
        assert_eq!(id.len(), "herdr-workflows:".len() + 8);
        assert_eq!(request["method"], "layout.apply");
        assert_eq!(request["params"], json!({ "focus": true }));
        stream
            .write_all(format!("{{\"id\":\"{id}\",\"result\":{{\"ok\":true}}}}\n").as_bytes())
            .expect("write");
    });
    let params = json!({ "focus": true });
    let result =
        herdr_call_at(&sock, "layout.apply", params.as_object().expect("o")).expect("result");
    assert_eq!(result, json!({ "ok": true }));
}

#[test]
fn error_response_unwraps_code_and_message() {
    let (_dir, sock) = with_server(|mut stream| {
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).expect("read");
        let request: Value = serde_json::from_str(line.trim()).expect("request json");
        let id = request["id"].as_str().expect("id");
        stream
            .write_all(
                format!(
                    "{{\"id\":\"{id}\",\"error\":{{\"code\":\"ui_busy\",\"message\":\"picker open\"}}}}\n"
                )
                .as_bytes(),
            )
            .expect("write");
    });
    let err = herdr_call_at(
        &sock,
        "plugin.pane.open",
        &json!({}).as_object().expect("o").clone(),
    )
    .expect_err("error unwrap");
    assert_eq!(err.code, "ui_busy");
    assert_eq!(err.message, "picker open");
    assert_eq!(err.to_string(), "picker open");
}

/// Fake herdr binary recording argv, one arg per line.
fn fake_herdr(dir: &Path, exit_code: u32, stderr: &str) -> (PathBuf, PathBuf) {
    let args_file = dir.join("args.txt");
    let bin = dir.join("herdr");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\nprintf '%s' '{}' >&2\nexit {exit_code}\n",
        args_file.display(),
        stderr
    );
    std::fs::write(&bin, script).expect("write fake herdr");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    (bin, args_file)
}

#[test]
fn wait_output_calls_pane_wait_output_with_regex_value_and_ms_timeout() {
    let dir = TempDir::new("wo");
    let (bin, args_file) = fake_herdr(dir.path(), 0, "");
    wait_output_with(&bin, "w-pane-1", "DONE.*", 60_000).expect("ok");
    let args: Vec<String> = std::fs::read_to_string(&args_file)
        .expect("args")
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        args,
        vec![
            "pane",
            "wait-output",
            "--regex",
            "DONE.*",
            "w-pane-1",
            "--timeout",
            "60000"
        ]
    );
}

#[test]
fn wait_output_nonzero_exit_is_herdr_error_with_stderr_message() {
    let dir = TempDir::new("wo");
    let (bin, _) = fake_herdr(dir.path(), 1, "match timeout");
    let err = wait_output_with(&bin, "w-pane-1", "x", 1000).expect_err("fails");
    assert_eq!(err.code, "wait_output_failed");
    assert_eq!(err.message, "match timeout");
}
