//! herdr socket JSON-RPC client. Port of `src/adapter/rpc.ts`: one NDJSON
//! request line over a `UnixStream`, one response line back, 10s timeout.
//!
//! The free functions read `HERDR_SOCKET_PATH` / `HERDR_BIN_PATH` per call
//! like the TS originals; the `_at`/`_with` variants take the value
//! explicitly so tests stay parallel-safe (Rust 2024 `env::set_var` is
//! `unsafe`, and this crate forbids unsafe code).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};
use thiserror::Error;

const RPC_TIMEOUT: Duration = Duration::from_millis(10_000);

/// herdr protocol failure — `HerdrError` in `src/adapter/rpc.ts`. `code` is
/// the machine-readable tag (`no_socket`, `timeout`, `closed`, `ui_busy`,
/// …); `message` is the user-facing text. Display prints the message only,
/// matching `Error.prototype.message`.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct HerdrError {
    pub code: String,
    pub message: String,
}

impl HerdrError {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Raw response frame — `HerdrResponse` in `src/adapter/rpc.ts`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HerdrResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<HerdrErrorBody>,
}

/// `error` payload of a [`HerdrResponse`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HerdrErrorBody {
    pub code: String,
    pub message: String,
}

/// `bin()` — `HERDR_BIN_PATH` override, else `herdr` from `PATH`.
#[must_use]
pub fn bin() -> PathBuf {
    std::env::var_os("HERDR_BIN_PATH").map_or_else(|| PathBuf::from("herdr"), PathBuf::from)
}

/// `socketPath()` — error `no_socket` when unset, same message as TS.
fn socket_path() -> Result<PathBuf, HerdrError> {
    std::env::var_os("HERDR_SOCKET_PATH")
        .map(PathBuf::from)
        .ok_or_else(|| HerdrError::new("no_socket", "HERDR_SOCKET_PATH is not set"))
}

fn request_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    format!("herdr-workflows:{}", &uuid[..8])
}

/// `herdrRequest` against an explicit socket path.
///
/// # Errors
/// `HerdrError` — `timeout` after 10s, `closed` when the socket ends before a
/// response line, `connect` when the dial fails, `invalid_json` when the
/// response line does not parse.
pub fn herdr_request_at(
    path: &Path,
    method: &str,
    params: &Map<String, Value>,
) -> Result<HerdrResponse, HerdrError> {
    let mut stream = UnixStream::connect(path)
        .map_err(|e| HerdrError::new("connect", format!("{method}: {e}")))?;
    stream
        .set_read_timeout(Some(RPC_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(RPC_TIMEOUT)))
        .map_err(|e| HerdrError::new("connect", format!("{method}: {e}")))?;

    let payload = serde_json::json!({ "id": request_id(), "method": method, "params": params });
    let mut line = serde_json::to_string(&payload)
        .map_err(|e| HerdrError::new("invalid_json", e.to_string()))?;
    line.push('\n');
    // A write error (EPIPE: peer already closed) does not settle the request —
    // fall through to the read, which reports EOF as `closed` like the TS
    // close-event path.
    let write_error = stream.write_all(line.as_bytes()).err();

    let mut response = String::new();
    let read = BufReader::new(&stream).read_line(&mut response);
    match read {
        Ok(0) => Err(HerdrError::new(
            "closed",
            format!("{method}: socket closed before response"),
        )),
        Ok(_) => serde_json::from_str(response.trim_end_matches(['\r', '\n']))
            .map_err(|e| HerdrError::new("invalid_json", e.to_string())),
        Err(e) => Err(match write_error {
            Some(write_error) => io_error(write_error, method),
            None => io_error(e, method),
        }),
    }
}

/// Map an I/O error from a timed socket op to the pinned TS messages.
fn io_error(error: std::io::Error, method: &str) -> HerdrError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ) {
        return HerdrError::new(
            "timeout",
            format!("{method} timed out after {}ms", RPC_TIMEOUT.as_millis()),
        );
    }
    HerdrError::new("io", format!("{method}: {error}"))
}

/// `herdrRequest` — socket path from `HERDR_SOCKET_PATH`.
///
/// # Errors
/// `HerdrError` — `no_socket` when the env var is unset, otherwise as
/// [`herdr_request_at`].
pub fn herdr_request(
    method: &str,
    params: &Map<String, Value>,
) -> Result<HerdrResponse, HerdrError> {
    herdr_request_at(&socket_path()?, method, params)
}

/// `herdrCall` against an explicit socket path.
///
/// # Errors
/// `HerdrError` — the response's own `error` (code/message preserved), or
/// `empty_result` when neither result nor error came back.
pub fn herdr_call_at(
    path: &Path,
    method: &str,
    params: &Map<String, Value>,
) -> Result<Value, HerdrError> {
    let response = herdr_request_at(path, method, params)?;
    if let Some(error) = response.error {
        return Err(HerdrError::new(error.code, error.message));
    }
    response
        .result
        .ok_or_else(|| HerdrError::new("empty_result", format!("no result for {method}")))
}

/// `herdrCall` — socket path from `HERDR_SOCKET_PATH`.
///
/// # Errors
/// As [`herdr_call_at`], plus `no_socket` when the env var is unset.
pub fn herdr_call(method: &str, params: &Map<String, Value>) -> Result<Value, HerdrError> {
    herdr_call_at(&socket_path()?, method, params)
}

/// Captured CLI subprocess result — the `herdrCli` return shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// `herdrCli` against an explicit binary. No timeout, same as TS.
///
/// # Errors
/// `HerdrError` with code `cli_spawn_failed` when the binary cannot be
/// spawned (TS surfaces the raw spawn exception; nothing pins its shape).
pub fn herdr_cli_with(bin: &Path, args: &[&str]) -> Result<CliOutput, HerdrError> {
    let output = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| HerdrError::new("cli_spawn_failed", e.to_string()))?;
    Ok(CliOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(1),
    })
}

/// `herdrCli` — binary from [`bin`].
///
/// # Errors
/// As [`herdr_cli_with`].
pub fn herdr_cli(args: &[&str]) -> Result<CliOutput, HerdrError> {
    herdr_cli_with(&bin(), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn herdr_error_display_is_message_only() {
        let err = HerdrError::new("ui_busy", "picker already open");
        assert_eq!(err.to_string(), "picker already open");
        assert_eq!(err.code, "ui_busy");
    }

    #[test]
    fn request_id_matches_ts_shape() {
        let id = request_id();
        assert!(id.starts_with("herdr-workflows:"));
        assert_eq!(id.len(), "herdr-workflows:".len() + 8);
    }

    #[test]
    fn herdr_cli_with_captures_streams_and_exit_code() {
        let out = herdr_cli_with(
            Path::new("sh"),
            &["-c", "printf out; printf err >&2; exit 3"],
        )
        .expect("sh runs");
        assert_eq!(
            out,
            CliOutput {
                stdout: "out".to_string(),
                stderr: "err".to_string(),
                exit_code: 3,
            }
        );
    }

    #[test]
    fn herdr_cli_with_missing_binary_is_spawn_failure() {
        let err =
            herdr_cli_with(Path::new("/nonexistent/hwf-no-such-bin"), &[]).expect_err("fails");
        assert_eq!(err.code, "cli_spawn_failed");
    }
}
