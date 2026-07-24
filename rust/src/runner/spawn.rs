//! Shared subprocess helper: `spawnCapture` from `src/runner/shell.ts`,
//! generalized from the 5s variant that lived in `workflow/inputs.rs`.
//! Single choke point for piped-capture spawns — own process group,
//! stdin/stdout/stderr pumped on threads (a chatty child cannot deadlock
//! the wait), process-group `SIGKILL` on timeout with the TS fallback chain
//! `kill(-pid)` → `child.kill()` preserved. Used by `runner::shell` (300s
//! steps), `runner::session` (session commands), and `workflow::inputs`
//! (5s options commands).

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use wait_timeout::ChildExt as _;

/// Captured subprocess result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    pub timed_out: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Spawn parameters. `env` entries overlay the inherited environment (the
/// TS callers always spread `process.env` first, so inherit + overlay is
/// equivalent).
pub struct SpawnOpts<'a> {
    pub cwd: &'a Path,
    pub stdin: Option<&'a str>,
    pub env: &'a [(String, String)],
    pub timeout: Duration,
}

/// Run `argv` to completion (or timeout), capturing stdout/stderr.
///
/// # Errors
/// `std::io::Error` only when the child cannot be spawned or waited on.
pub fn spawn_capture(argv: &[String], opts: &SpawnOpts) -> std::io::Result<Capture> {
    use std::os::unix::process::CommandExt as _;
    let Some((program, args)) = argv.split_first() else {
        return Err(std::io::Error::other("empty argv"));
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(opts.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    command.stdin(match opts.stdin {
        Some(_) => Stdio::piped(),
        None => Stdio::null(),
    });
    let mut child = command.spawn()?;

    // stdin on its own thread: a large script must not block the parent
    // while the child fills the stdout pipe. EPIPE (child exits early) is
    // expected and ignored.
    let stdin_thread = opts.stdin.and_then(|text| {
        child.stdin.take().map(|mut pipe| {
            let text = text.to_string();
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            })
        })
    });
    let mut out_pipe = child.stdout.take().expect("stdout was piped");
    let mut err_pipe = child.stderr.take().expect("stderr was piped");
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

    let (timed_out, exit_code) = match child.wait_timeout(opts.timeout)? {
        Some(status) => (false, status.code().unwrap_or(1)),
        None => {
            let killed = match i32::try_from(child.id()) {
                Ok(pid) => nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(-pid),
                    nix::sys::signal::Signal::SIGKILL,
                )
                .is_ok(),
                Err(_) => false,
            };
            if !killed {
                let _ = child.kill();
            }
            let _ = child.wait();
            (true, 1)
        }
    };
    if let Some(thread) = stdin_thread {
        let _ = thread.join();
    }
    let stdout = out_thread.join().expect("stdout reader panicked");
    let stderr = err_thread.join().expect("stderr reader panicked");
    Ok(Capture {
        timed_out,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Vec<String> {
        vec!["sh".to_string(), "-c".to_string(), script.to_string()]
    }

    fn opts<'a>(cwd: &'a Path, timeout: Duration) -> SpawnOpts<'a> {
        SpawnOpts {
            cwd,
            stdin: None,
            env: &[],
            timeout,
        }
    }

    #[test]
    fn captures_stdout_stderr_and_exit_code() {
        let dir = std::env::temp_dir();
        let capture = spawn_capture(
            &sh("printf out; printf err >&2; exit 3"),
            &opts(&dir, Duration::from_secs(5)),
        )
        .expect("spawn");
        assert!(!capture.timed_out);
        assert_eq!(capture.exit_code, 3);
        assert_eq!(capture.stdout, "out");
        assert_eq!(capture.stderr, "err");
    }

    #[test]
    fn stdin_is_piped_to_child() {
        let dir = std::env::temp_dir();
        let capture = spawn_capture(
            &sh("cat"),
            &SpawnOpts {
                stdin: Some("hello stdin"),
                ..opts(&dir, Duration::from_secs(5))
            },
        )
        .expect("spawn");
        assert_eq!(capture.stdout, "hello stdin");
    }

    #[test]
    fn extra_env_overlays_inherited() {
        let dir = std::env::temp_dir();
        let capture = spawn_capture(
            &sh("printf %s \"$HWF_SPAWN_TEST\""),
            &SpawnOpts {
                env: &[("HWF_SPAWN_TEST".to_string(), "v1".to_string())],
                ..opts(&dir, Duration::from_secs(5))
            },
        )
        .expect("spawn");
        assert_eq!(capture.stdout, "v1");
    }

    #[test]
    fn timeout_kills_process_group() {
        let dir = std::env::temp_dir().join(format!("hwf-spawn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pid_file = dir.join("child.pid");
        let script = format!("sleep 60 & echo $! > \"{}\"; wait", pid_file.display());
        let capture =
            spawn_capture(&sh(&script), &opts(&dir, Duration::from_millis(300))).expect("spawn");
        assert!(capture.timed_out);
        assert_eq!(capture.exit_code, 1);
        // Give the group kill a beat to land, then check the grandchild.
        std::thread::sleep(Duration::from_millis(100));
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("numeric pid");
        let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok();
        assert!(!alive, "grandchild must be killed with the group");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
