//! Per-agent session extraction. Port of `src/session.ts`: configured
//! `sessions:` argv commands win; `claude` falls back to reading the JSONL
//! transcript under `~/.claude/projects`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::shell::{SHELL_TIMEOUT_MS, timeout_secs};
use super::spawn::{self, SpawnOpts};
use crate::config::SessionsConfig;
use crate::herdr::cli::AgentSessionInfo;
use crate::herdr::rpc::HerdrError;

/// `slug` — cwd → Claude projects directory name.
#[must_use]
pub fn slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Text of one message `content` field: the string itself, or the
/// concatenated `text` blocks of a content array.
fn extract_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect()
}

/// `extractSessionTranscript` — user/assistant entries only, bad lines
/// skipped, entries joined by a blank line.
#[must_use]
pub fn extract_session_transcript(jsonl: &str) -> String {
    let mut entries: Vec<String> = Vec::new();
    for line in jsonl.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(kind) = row.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let Some(content) = row.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let text = extract_text(content);
        if text.is_empty() {
            continue;
        }
        entries.push(format!("{kind}:\n{text}"));
    }
    entries.join("\n\n")
}

/// Default transcript root: `~/.claude/projects`.
#[must_use]
pub fn claude_projects_base() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
}

/// `readClaudeTranscript`.
///
/// # Errors
/// `HerdrError` — `session_file_missing` (path in the message) or
/// `session_file_unreadable`.
pub fn read_claude_transcript(
    cwd: &str,
    session_id: &str,
    base: &Path,
) -> Result<String, HerdrError> {
    let path = base.join(slug(cwd)).join(format!("{session_id}.jsonl"));
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(extract_session_transcript(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(HerdrError::new(
            "session_file_missing",
            format!("session file not found: {}", path.display()),
        )),
        Err(e) => Err(HerdrError::new(
            "session_file_unreadable",
            format!("session file unreadable: {} ({e})", path.display()),
        )),
    }
}

fn stderr_tail(stderr: &str) -> &str {
    let trimmed = stderr.trim();
    if trimmed.len() <= 500 {
        return trimmed;
    }
    let mut boundary = trimmed.len() - 500;
    while !trimmed.is_char_boundary(boundary) {
        boundary += 1;
    }
    &trimmed[boundary..]
}

/// `runSessionCommand` — argv in the session's cwd with the three
/// `HERDR_WORKFLOWS_SESSION_*` vars, default 300s timeout.
fn run_session_command(argv: &[String], info: &AgentSessionInfo) -> Result<String, HerdrError> {
    let env = [
        (
            "HERDR_WORKFLOWS_SESSION_ID".to_string(),
            info.session_id.clone(),
        ),
        ("HERDR_WORKFLOWS_SESSION_CWD".to_string(), info.cwd.clone()),
        (
            "HERDR_WORKFLOWS_SESSION_AGENT".to_string(),
            info.agent.clone(),
        ),
    ];
    let agent = &info.agent;
    let fail = |detail: String| HerdrError::new("session_command_failed", detail);
    let capture = spawn::spawn_capture(
        argv,
        &SpawnOpts {
            cwd: Path::new(&info.cwd),
            stdin: None,
            env: &env,
            timeout: Duration::from_millis(SHELL_TIMEOUT_MS),
        },
    )
    .map_err(|e| fail(format!("session command for '{agent}' failed: {e}")))?;
    if capture.timed_out {
        return Err(fail(format!(
            "session command for '{agent}' failed: timed out after {}s",
            timeout_secs(SHELL_TIMEOUT_MS)
        )));
    }
    if capture.exit_code != 0 {
        let tail = stderr_tail(&capture.stderr);
        let detail = if tail.is_empty() {
            format!("exit {}", capture.exit_code)
        } else {
            tail.to_string()
        };
        return Err(fail(format!(
            "session command for '{agent}' failed: {detail}"
        )));
    }
    if capture.stdout.trim().is_empty() {
        return Err(HerdrError::new(
            "session_command_empty",
            format!("session command for '{agent}' printed nothing"),
        ));
    }
    Ok(capture.stdout)
}

/// `sessionText` — configured argv for the agent wins, bare `claude` reads
/// the transcript, anything else names the fix. `get_info` and
/// `projects_base` are the TS injectables (tests, `LiveHerdr` default).
///
/// # Errors
/// `HerdrError` from `get_info`, the session command, the transcript read,
/// or `session_unsupported_agent`.
pub fn session_text(
    pane_id: &str,
    sessions: &SessionsConfig,
    get_info: &dyn Fn(&str) -> Result<AgentSessionInfo, HerdrError>,
    projects_base: Option<&Path>,
) -> Result<String, HerdrError> {
    let info = get_info(pane_id)?;
    if let Some(argv) = sessions.get(&info.agent) {
        return run_session_command(argv, &info);
    }
    if info.agent == "claude" {
        let base = projects_base.map_or_else(claude_projects_base, Path::to_path_buf);
        return read_claude_transcript(&info.cwd, &info.session_id, &base);
    }
    Err(HerdrError::new(
        "session_unsupported_agent",
        format!(
            "no sessions entry for '{}' — add one to .hwf/config.yaml (built-in support: claude)",
            info.agent
        ),
    ))
}

/// The default wiring: `agent get` from the live herdr CLI, default
/// transcript root.
///
/// # Errors
/// As [`session_text`].
pub fn session_text_default(
    pane_id: &str,
    sessions: &SessionsConfig,
) -> Result<String, HerdrError> {
    session_text(
        pane_id,
        sessions,
        &crate::herdr::cli::agent_session_info,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("hwf-session-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn info(agent: &str, session_id: &str, cwd: &str) -> AgentSessionInfo {
        AgentSessionInfo {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
        }
    }

    fn fixed_info(
        agent: &str,
        session_id: &str,
        cwd: &str,
    ) -> impl Fn(&str) -> Result<AgentSessionInfo, HerdrError> {
        let info = info(agent, session_id, cwd);
        move |_| Ok(info.clone())
    }

    fn sessions(pairs: &[(&str, Vec<String>)]) -> SessionsConfig {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn slug_replaces_non_alnum_with_dashes() {
        assert_eq!(slug("/Users/x/y"), "-Users-x-y");
    }

    #[test]
    fn extracts_string_and_text_block_content_skips_tools_and_bad_json() {
        let jsonl = [
            serde_json::json!({"type":"user","message":{"content":"hello"}}).to_string(),
            "not-json".to_string(),
            serde_json::json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"world"},
                {"type":"tool_use","name":"Bash","input":{}},
                {"type":"tool_result","content":"skip me"}
            ]}})
            .to_string(),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}})
                .to_string(),
            serde_json::json!({"type":"system","message":{"content":"ignore"}}).to_string(),
        ]
        .join("\n");
        assert_eq!(
            extract_session_transcript(&jsonl),
            "user:\nhello\n\nassistant:\nworld"
        );
    }

    #[test]
    fn read_claude_transcript_loads_fixture_and_missing_names_path() {
        let base = TempDir::new("fixture");
        let cwd = "/Users/x/y";
        let dir = base.0.join(slug(cwd));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("abc123.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"type":"user","message":{"content":"from file"}})
            ),
        )
        .expect("write");
        assert_eq!(
            read_claude_transcript(cwd, "abc123", &base.0).expect("read"),
            "user:\nfrom file"
        );
        let err = read_claude_transcript(cwd, "nope", &base.0).expect_err("missing");
        assert_eq!(err.code, "session_file_missing");
        assert!(
            err.message
                .contains(&dir.join("nope.jsonl").display().to_string())
        );
    }

    #[test]
    fn configured_command_wins_and_env_and_cwd_honored() {
        let cwd = TempDir::new("cwd");
        let out = session_text(
            "pane-1",
            &sessions(&[(
                "claude",
                vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "printf 'id=%s cwd=%s agent=%s' \"$HERDR_WORKFLOWS_SESSION_ID\" \"$HERDR_WORKFLOWS_SESSION_CWD\" \"$HERDR_WORKFLOWS_SESSION_AGENT\"".to_string(),
                ],
            )]),
            &fixed_info("claude", "sid-9", &cwd.0.display().to_string()),
            None,
        )
        .expect("command");
        assert_eq!(
            out,
            format!("id=sid-9 cwd={} agent=claude", cwd.0.display())
        );
    }

    #[test]
    fn nonzero_exit_names_agent_with_stderr_tail() {
        let cwd = std::env::temp_dir().display().to_string();
        let err = session_text(
            "p",
            &sessions(&[(
                "codex",
                vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "echo boom >&2; exit 2".to_string(),
                ],
            )]),
            &fixed_info("codex", "s", &cwd),
            None,
        )
        .expect_err("fails");
        assert_eq!(err.code, "session_command_failed");
        assert!(
            err.message.contains("session command for 'codex' failed:")
                && err.message.contains("boom"),
            "got: {}",
            err.message
        );
    }

    #[test]
    fn empty_stdout_errors() {
        let cwd = std::env::temp_dir().display().to_string();
        let err = session_text(
            "p",
            &sessions(&[(
                "codex",
                vec!["sh".to_string(), "-c".to_string(), "true".to_string()],
            )]),
            &fixed_info("codex", "s", &cwd),
            None,
        )
        .expect_err("empty");
        assert_eq!(err.code, "session_command_empty");
        assert_eq!(err.message, "session command for 'codex' printed nothing");
    }

    #[test]
    fn no_entry_and_claude_uses_builtin_transcript() {
        let base = TempDir::new("builtin");
        let cwd = "/Users/x/y";
        let dir = base.0.join(slug(cwd));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("abc123.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"type":"user","message":{"content":"builtin"}})
            ),
        )
        .expect("write");
        let out = session_text(
            "p",
            &SessionsConfig::new(),
            &fixed_info("claude", "abc123", cwd),
            Some(&base.0),
        )
        .expect("builtin");
        assert_eq!(out, "user:\nbuiltin");
    }

    #[test]
    fn no_entry_and_other_agent_names_fix() {
        let cwd = std::env::temp_dir().display().to_string();
        let err = session_text(
            "p",
            &SessionsConfig::new(),
            &fixed_info("codex", "s", &cwd),
            None,
        )
        .expect_err("unsupported");
        assert_eq!(err.code, "session_unsupported_agent");
        assert_eq!(
            err.message,
            "no sessions entry for 'codex' — add one to .hwf/config.yaml (built-in support: claude)"
        );
    }
}
