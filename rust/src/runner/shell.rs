//! Shell step execution. Port of `src/runner/shell.ts`: `sh -c` with a
//! 300s default timeout via the shared [`super::spawn`] helper.

use std::path::Path;
use std::time::Duration;

use super::spawn::{self, SpawnOpts};
use crate::herdr::rpc::HerdrError;

/// `SHELL_TIMEOUT_MS`.
pub const SHELL_TIMEOUT_MS: u64 = 300_000;

/// `shellArgv` — Windows branch dropped per the rewrite's non-goals.
#[must_use]
pub fn shell_argv(command: &str) -> Vec<String> {
    vec!["sh".to_string(), "-c".to_string(), command.to_string()]
}

/// `runShellStep` result. On timeout the message `timed out after Ns`
/// replaces an empty stderr, as TS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// `timeoutMs / 1000` rendered the JS way: integer when it divides, else a
/// plain decimal (`400 → "0.4"`, `300000 → "300"`).
#[must_use]
pub fn timeout_secs(ms: u64) -> String {
    if ms % 1000 == 0 {
        format!("{}", ms / 1000)
    } else {
        format!("{}", ms as f64 / 1000.0)
    }
}

/// `runShellStep`.
///
/// # Errors
/// `HerdrError` with code `shell_spawn_failed` when the shell itself cannot
/// be spawned (TS propagates the raw spawn exception; nothing pins its shape).
pub fn run_shell_step(
    command: &str,
    cwd: &Path,
    stdin: Option<&str>,
    env: &[(String, String)],
    timeout_ms: Option<u64>,
) -> Result<ShellOutput, HerdrError> {
    let timeout_ms = timeout_ms.unwrap_or(SHELL_TIMEOUT_MS);
    let capture = spawn::spawn_capture(
        &shell_argv(command),
        &SpawnOpts {
            cwd,
            stdin,
            env,
            timeout: Duration::from_millis(timeout_ms),
        },
    )
    .map_err(|e| HerdrError::new("shell_spawn_failed", e.to_string()))?;
    if capture.timed_out {
        let stderr = if capture.stderr.is_empty() {
            format!("timed out after {}s", timeout_secs(timeout_ms))
        } else {
            capture.stderr
        };
        return Ok(ShellOutput {
            ok: false,
            stdout: capture.stdout,
            stderr,
        });
    }
    Ok(ShellOutput {
        ok: capture.exit_code == 0,
        stdout: capture.stdout,
        stderr: capture.stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_timeout_constant_matches_ts() {
        assert_eq!(SHELL_TIMEOUT_MS, 300_000);
    }

    #[test]
    fn shell_argv_is_sh_c() {
        assert_eq!(shell_argv("echo hi"), vec!["sh", "-c", "echo hi"]);
    }

    #[test]
    fn timeout_secs_matches_js_division() {
        assert_eq!(timeout_secs(300_000), "300");
        assert_eq!(timeout_secs(400), "0.4");
        assert_eq!(timeout_secs(1_500), "1.5");
    }

    #[test]
    fn nonzero_exit_is_not_ok_and_keeps_stderr() {
        let dir = std::env::temp_dir();
        let out = run_shell_step("echo boom >&2; exit 2", &dir, None, &[], None).expect("spawn");
        assert!(!out.ok);
        assert_eq!(out.stderr, "boom\n");
    }

    #[test]
    fn timeout_message_when_stderr_empty() {
        let dir = std::env::temp_dir();
        let out = run_shell_step("sleep 5", &dir, None, &[], Some(300)).expect("spawn");
        assert!(!out.ok);
        assert_eq!(out.stderr, "timed out after 0.3s");
    }
}
