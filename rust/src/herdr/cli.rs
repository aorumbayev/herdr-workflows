//! `herdr` CLI subprocess wrappers + socket-only calls. Port of
//! `src/adapter/client.ts`. Wrappers map a non-zero exit to a pinned
//! `HerdrError` code; message is trimmed stderr, falling back to stdout
//! then a generic label, exactly as TS.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::rpc::{HerdrError, herdr_call, herdr_cli, herdr_cli_with};

/// `tabClose`.
///
/// # Errors
/// `HerdrError` from the socket call.
pub fn tab_close(tab_id: &str) -> Result<(), HerdrError> {
    herdr_call(
        "tab.close",
        &json!({ "tab_id": tab_id })
            .as_object()
            .expect("object")
            .clone(),
    )?;
    Ok(())
}

/// `LayoutApplyResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutApplyResult {
    pub tab_id: String,
    pub pane_id: String,
    pub workspace_id: String,
}

/// `layoutApply` params. `focus` defaults to `true` in the payload, as TS.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LayoutApplyParams {
    pub workspace_id: Option<String>,
    pub tab_label: String,
    pub tab_id: Option<String>,
    pub cwd: String,
    pub command: Vec<String>,
    pub label: String,
    pub env: BTreeMap<String, String>,
    pub focus: Option<bool>,
}

/// `layoutApply` — socket-only (no CLI surface). herdr rejects both
/// `tab_id` and `workspace_id` set, so `workspace_id` goes out as null when
/// `tab_id` is present.
///
/// # Errors
/// `HerdrError` — the socket error, or `layout_apply_failed` when the
/// response lacks tab/pane/workspace ids.
pub fn layout_apply(params: &LayoutApplyParams) -> Result<LayoutApplyResult, HerdrError> {
    let payload = json!({
        "workspace_id": if params.tab_id.is_some() { Value::Null } else { json!(params.workspace_id) },
        "tab_label": params.tab_label,
        "tab_id": params.tab_id,
        "focus": params.focus.unwrap_or(true),
        "root": {
            "type": "pane",
            "label": params.label,
            "cwd": params.cwd,
            "command": params.command,
            "env": params.env,
        },
    });
    let result = herdr_call("layout.apply", as_object(&payload))?;
    let layout = result.get("layout");
    let tab_id = layout.and_then(|l| l.get("tab_id")).and_then(Value::as_str);
    let pane_id = layout
        .and_then(|l| l.get("focused_pane_id"))
        .and_then(Value::as_str);
    let workspace_id = layout
        .and_then(|l| l.get("workspace_id"))
        .and_then(Value::as_str)
        .or(params.workspace_id.as_deref());
    let (Some(tab_id), Some(pane_id), Some(workspace_id)) = (tab_id, pane_id, workspace_id) else {
        return Err(HerdrError::new(
            "layout_apply_failed",
            "layout.apply missing tab/pane ids",
        ));
    };
    Ok(LayoutApplyResult {
        tab_id: tab_id.to_string(),
        pane_id: pane_id.to_string(),
        workspace_id: workspace_id.to_string(),
    })
}

fn as_object(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("payload built as object")
}

/// `pluginPaneOpen` — socket instead of CLI: skips a herdr subprocess on the
/// picker hot path. `focus: true` matches the CLI default.
///
/// # Errors
/// `HerdrError` from the socket call (`ui_busy` when another popup is open).
pub fn plugin_pane_open(
    entrypoint: &str,
    env: &BTreeMap<String, String>,
    placement: Option<&str>,
) -> Result<(), HerdrError> {
    let plugin_id = std::env::var("HERDR_PLUGIN_ID").unwrap_or_else(|_| "herdr-workflows".into());
    let payload = json!({
        "plugin_id": plugin_id,
        "entrypoint": entrypoint,
        "placement": placement,
        "focus": true,
        "env": env,
    });
    herdr_call("plugin.pane.open", as_object(&payload))?;
    Ok(())
}

/// Pane-read options — `{ source, lines }` in TS.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PaneReadOpts {
    pub source: Option<&'static str>,
    pub lines: Option<u32>,
}

/// `paneRead`.
///
/// # Errors
/// `HerdrError` with code `pane_read_failed` on non-zero exit.
pub fn pane_read(pane_id: &str, opts: PaneReadOpts) -> Result<String, HerdrError> {
    let mut args = vec!["pane", "read", pane_id, "--format", "text"];
    if let Some(source) = opts.source {
        args.extend(["--source", source]);
    }
    let lines;
    if let Some(n) = opts.lines {
        lines = n.to_string();
        args.extend(["--lines", &lines]);
    }
    let out = herdr_cli(&args)?;
    if out.exit_code != 0 {
        return Err(HerdrError::new(
            "pane_read_failed",
            non_empty(&out.stderr, &out.stdout, "pane read failed"),
        ));
    }
    Ok(out.stdout)
}

/// `notificationShow`.
///
/// # Errors
/// `HerdrError` with code `notification_show_failed` on non-zero exit.
pub fn notification_show(title: &str, body: Option<&str>) -> Result<(), HerdrError> {
    let mut args = vec!["notification", "show", title];
    if let Some(body) = body {
        args.extend(["--body", body]);
    }
    let out = herdr_cli(&args)?;
    if out.exit_code != 0 {
        return Err(HerdrError::new(
            "notification_show_failed",
            non_empty(&out.stderr, &out.stdout, "notification show failed"),
        ));
    }
    Ok(())
}

/// Trimmed stderr, else trimmed stdout, else the generic label — the TS
/// `stderr.trim() || stdout.trim() || label` chain (`pane_read` pins stderr-only).
fn non_empty(stderr: &str, stdout: &str, label: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    label.to_string()
}

/// Raw `agent get` result: the `result.agent` subtree as JSON (`Null` when
/// absent, matching TS `undefined` handling downstream).
fn agent_get(pane_id: &str) -> Result<Value, HerdrError> {
    let out = herdr_cli(&["agent", "get", pane_id])?;
    if out.exit_code != 0 {
        return Err(HerdrError::new(
            "agent_status_failed",
            non_empty(&out.stderr, "", "agent get failed"),
        ));
    }
    let parsed: Value = serde_json::from_str(out.stdout.trim())
        .map_err(|_| HerdrError::new("agent_status_failed", "agent get returned invalid JSON"))?;
    Ok(parsed
        .get("result")
        .and_then(|r| r.get("agent"))
        .cloned()
        .unwrap_or(Value::Null))
}

/// `agentStatus` — the `agent_status` string.
///
/// # Errors
/// `HerdrError` with code `agent_status_failed` when absent or not a string.
pub fn agent_status(pane_id: &str) -> Result<String, HerdrError> {
    let agent = agent_get(pane_id)?;
    agent
        .get("agent_status")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HerdrError::new("agent_status_failed", "agent get missing agent_status"))
}

/// `agentLabel` — the detected agent name.
///
/// # Errors
/// `HerdrError` with code `no_agent` when the pane has no agent.
pub fn agent_label(pane_id: &str) -> Result<String, HerdrError> {
    let agent = agent_get(pane_id)?;
    match agent.get("agent").and_then(Value::as_str) {
        Some(name) if !name.is_empty() => Ok(name.to_string()),
        _ => Err(HerdrError::new(
            "no_agent",
            "no agent detected in this pane",
        )),
    }
}

/// `AgentSessionInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionInfo {
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
}

/// `agentSessionInfo`.
///
/// # Errors
/// `HerdrError` with code `no_agent_session` when any of agent/session/cwd is
/// missing.
pub fn agent_session_info(pane_id: &str) -> Result<AgentSessionInfo, HerdrError> {
    let info = agent_get(pane_id)?;
    let agent = info.get("agent").and_then(Value::as_str);
    let session_id = info
        .get("agent_session")
        .and_then(|s| s.get("value"))
        .and_then(Value::as_str);
    let cwd = info.get("cwd").and_then(Value::as_str);
    let (Some(agent), Some(session_id), Some(cwd)) = (agent, session_id, cwd) else {
        return Err(HerdrError::new(
            "no_agent_session",
            "no agent session detected in this pane",
        ));
    };
    Ok(AgentSessionInfo {
        agent: agent.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    })
}

/// `waitOutput` against an explicit herdr binary (test seam — the pinned
/// argv shape is asserted without a live herdr).
///
/// # Errors
/// `HerdrError` with code `wait_output_failed` on non-zero exit.
pub fn wait_output_with(
    bin: &Path,
    pane_id: &str,
    regex: &str,
    timeout_ms: u64,
) -> Result<(), HerdrError> {
    let timeout = timeout_ms.to_string();
    // herdr 0.7.5 removed top-level `wait`; `pane wait-output` takes the
    // pattern as --regex's value.
    let out = herdr_cli_with(
        bin,
        &[
            "pane",
            "wait-output",
            "--regex",
            regex,
            pane_id,
            "--timeout",
            &timeout,
        ],
    )?;
    if out.exit_code != 0 {
        return Err(HerdrError::new(
            "wait_output_failed",
            non_empty(&out.stderr, &out.stdout, "wait output failed"),
        ));
    }
    Ok(())
}

/// `waitOutput`.
///
/// # Errors
/// As [`wait_output_with`].
pub fn wait_output(pane_id: &str, regex: &str, timeout_ms: u64) -> Result<(), HerdrError> {
    wait_output_with(&super::rpc::bin(), pane_id, regex, timeout_ms)
}

/// `reportToken` — `None` clears the token.
///
/// # Errors
/// `HerdrError` with code `report_token_failed` on non-zero exit.
pub fn report_token(pane_id: &str, value: Option<&str>) -> Result<(), HerdrError> {
    let token;
    let args: Vec<&str> = match value {
        None => vec![
            "pane",
            "report-metadata",
            pane_id,
            "--source",
            "herdr-workflows",
            "--clear-token",
            "herdr-workflows",
        ],
        Some(value) => {
            token = format!("herdr-workflows={value}");
            vec![
                "pane",
                "report-metadata",
                pane_id,
                "--source",
                "herdr-workflows",
                "--token",
                &token,
                "--ttl-ms",
                "600000",
            ]
        }
    };
    let out = herdr_cli(&args)?;
    if out.exit_code != 0 {
        return Err(HerdrError::new(
            "report_token_failed",
            non_empty(&out.stderr, &out.stdout, "report token failed"),
        ));
    }
    Ok(())
}
