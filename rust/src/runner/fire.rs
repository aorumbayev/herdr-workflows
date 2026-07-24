//! Pane-creating step dispatch (`open` / `agent` / `herdr`). Port of
//! `src/runner/fire.ts`, including the `fail` notifier shared with
//! `dispatch` and `runner`.

use serde_json::{Map, Value};

use super::agent_wait::wait_agent_done;
use super::context::{PANE_READ_LINES, PANE_READ_SOURCE};
use super::deps::{Herdr, StepResult, StepRunOptions};
use super::shell::shell_argv;
use crate::config::fill_agent_argv;
use crate::herdr::cli::{LayoutApplyParams, PaneReadOpts};
use crate::workflow::placeholder::agent_input_ref;
use crate::workflow::steps::FlatStep;
use crate::workflow::substitute::{PlaceholderValues, substitute, substitute_params};

const INVOKING_AGENT: &str = "{agent}";

/// `FireOutcome` — any subset of failed/last/tabId, as TS.
#[derive(Debug, Default)]
pub struct FireOutcome {
    pub failed: Option<StepResult>,
    pub last: Option<String>,
    pub tab_id: Option<String>,
}

/// `fail` — notify (best-effort) and return the error text, truncated to
/// the last 500 chars with an ellipsis prefix.
pub fn fail(herdr: &dyn Herdr, workflow: &str, step: usize, detail: &str) -> String {
    let text = format!("step {step}: {detail}");
    let body = if text.chars().count() > 500 {
        let tail: String = text.chars().skip(text.chars().count() - 500).collect();
        format!("…{tail}")
    } else {
        text
    };
    let _ = herdr.notification_show(&format!("herdr-workflows: {workflow} failed"), Some(&body));
    body
}

/// `autofill` — herdr-step params get the invoking ids when not pinned.
/// Input is the workflow's `BTreeMap` params; output is the socket payload
/// object.
fn autofill(
    params: Option<&std::collections::BTreeMap<String, Value>>,
    opts: &StepRunOptions,
) -> Map<String, Value> {
    let mut out: Map<String, Value> = params.cloned().unwrap_or_default().into_iter().collect();
    if !out.contains_key("pane_id")
        && let Some(pane_id) = &opts.ctx.pane_id
    {
        out.insert("pane_id".to_string(), Value::String(pane_id.clone()));
    }
    if !out.contains_key("tab_id")
        && let Some(tab_id) = &opts.ctx.tab_id
    {
        out.insert("tab_id".to_string(), Value::String(tab_id.clone()));
    }
    if !out.contains_key("workspace_id")
        && let Some(workspace_id) = &opts.ctx.workspace_id
    {
        out.insert(
            "workspace_id".to_string(),
            Value::String(workspace_id.clone()),
        );
    }
    out
}

/// `resolveAgentName` — `{agent}` from the invocation snapshot, `{input.*}`
/// from resolved inputs, anything else verbatim.
fn resolve_agent_name(step_name: &str, values: &PlaceholderValues) -> String {
    if step_name == INVOKING_AGENT {
        return values.agent.clone();
    }
    if let Some(input) = agent_input_ref(step_name) {
        return values.inputs.get(&input).cloned().unwrap_or_default();
    }
    step_name.to_string()
}

/// `fireOpen`.
fn fire_open(
    opts: &StepRunOptions,
    command: &str,
    wait_for: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<FireOutcome, String> {
    // `" x".split(/\s+/)[0]` is "" → TS falls back to "open"; mirror that.
    let first = command.split(char::is_whitespace).next().unwrap_or("");
    let label = if first.is_empty() { "open" } else { first };
    let applied = opts
        .herdr
        .layout_apply(&LayoutApplyParams {
            workspace_id: opts.ctx.workspace_id.clone(),
            tab_label: label.to_string(),
            tab_id: None,
            cwd: opts.ctx.cwd.clone(),
            command: shell_argv(command),
            label: label.to_string(),
            env: Default::default(),
            focus: Some(true),
        })
        .map_err(|e| e.message)?;
    if let Some(pattern) = wait_for {
        opts.herdr
            .wait_output(
                &applied.pane_id,
                pattern,
                timeout_ms.expect("wait_for implies timeout"),
            )
            .map_err(|e| e.message)?;
    }
    Ok(FireOutcome {
        tab_id: Some(applied.tab_id),
        ..FireOutcome::default()
    })
}

/// Borrowed view of a `FlatStep::Agent`'s fields, so `fire_agent` stays
/// under the argument-count lint.
struct AgentStep<'a> {
    name: &'a str,
    prompt: Option<&'a str>,
    wait: bool,
    timeout_ms: Option<u64>,
    close_source: bool,
}

/// `fireAgent`. Returns `Ok(None)` when the step already produced a
/// `failed` outcome (unresolved/unknown agent), like the TS early returns.
fn fire_agent(
    opts: &StepRunOptions,
    step: &AgentStep,
    values: &PlaceholderValues,
    n: usize,
    last: &str,
) -> Result<Option<FireOutcome>, String> {
    let resolved = resolve_agent_name(step.name, values);
    if step.name == INVOKING_AGENT && resolved.is_empty() {
        let error = fail(
            opts.herdr,
            opts.name,
            n,
            "invoking agent unresolved — run from agent pane",
        );
        return Ok(Some(FireOutcome {
            failed: Some(StepResult::failed(error, last.to_string())),
            ..FireOutcome::default()
        }));
    }
    let Some(template) = opts.agents.get(&resolved) else {
        let error = fail(
            opts.herdr,
            opts.name,
            n,
            &format!("unknown agent '{resolved}'"),
        );
        return Ok(Some(FireOutcome {
            failed: Some(StepResult::failed(error, last.to_string())),
            ..FireOutcome::default()
        }));
    };
    let prompt = step
        .prompt
        .map_or_else(String::new, |p| substitute(p, values));
    let applied = opts
        .herdr
        .layout_apply(&LayoutApplyParams {
            workspace_id: opts.ctx.workspace_id.clone(),
            tab_label: resolved.clone(),
            tab_id: None,
            cwd: opts.ctx.cwd.clone(),
            command: fill_agent_argv(template, &prompt),
            label: resolved,
            env: Default::default(),
            focus: Some(true),
        })
        .map_err(|e| e.message)?;
    // Close source only after target opened — failure above leaves the
    // original tab intact.
    if step.close_source
        && let Some(tab_id) = &opts.ctx.tab_id
    {
        opts.herdr.tab_close(tab_id).map_err(|e| e.message)?;
    }
    if !step.wait {
        return Ok(Some(FireOutcome {
            tab_id: Some(applied.tab_id),
            ..FireOutcome::default()
        }));
    }
    let mut status = |pane: &str| opts.herdr.agent_status(pane);
    let on_blocked = || {
        opts.herdr.notification_show(
            &format!("herdr-workflows: {} waiting", opts.name),
            Some(&format!("agent blocked on step {n} — needs your input")),
        )
    };
    wait_agent_done(
        &applied.pane_id,
        std::time::Duration::from_millis(step.timeout_ms.expect("wait implies timeout")),
        &mut status,
        opts.wait_clock,
        Some(&on_blocked),
    )
    .map_err(|e| e.message)?;
    let text = opts
        .herdr
        .pane_read(
            &applied.pane_id,
            PaneReadOpts {
                source: Some(PANE_READ_SOURCE),
                lines: Some(PANE_READ_LINES),
            },
        )
        .map_err(|e| e.message)?;
    Ok(Some(FireOutcome {
        last: Some(text.trim().to_string()),
        tab_id: Some(applied.tab_id),
        failed: None,
    }))
}

/// `fire` — non-shell steps. Any herder error becomes a `failed` outcome
/// carrying the notified message.
pub fn fire(
    opts: &StepRunOptions,
    step: &FlatStep,
    values: &PlaceholderValues,
    n: usize,
    last: &str,
) -> FireOutcome {
    let result: Result<Option<FireOutcome>, String> = match step {
        FlatStep::Open {
            command,
            wait_for,
            timeout_ms,
        } => fire_open(opts, command, wait_for.as_deref(), *timeout_ms).map(Some),
        FlatStep::Agent {
            name,
            prompt,
            wait,
            timeout_ms,
            close_source,
        } => fire_agent(
            opts,
            &AgentStep {
                name,
                prompt: prompt.as_deref(),
                wait: *wait,
                timeout_ms: *timeout_ms,
                close_source: *close_source,
            },
            values,
            n,
            last,
        ),
        FlatStep::Herdr { method, params } => opts
            .herdr
            .herdr_call(
                method,
                autofill(substitute_params(params.as_ref(), values).as_ref(), opts),
            )
            .map(|_| None)
            .map_err(|e| e.message),
        FlatStep::Shell { .. } => unreachable!("shell steps never reach fire"),
    };
    match result {
        Ok(Some(outcome)) => outcome,
        Ok(None) => FireOutcome::default(),
        Err(detail) => FireOutcome {
            failed: Some(StepResult::failed(
                fail(opts.herdr, opts.name, n, &detail),
                last.to_string(),
            )),
            ..FireOutcome::default()
        },
    }
}
