//! `rawToFlat` / `checkAgents` / `flatNeeds*`. Port of `src/workflows/steps.ts`.

use std::collections::{BTreeMap, HashSet};

use super::errors::{WorkflowLoadError, positioned};
use super::placeholder::{
    agent_input_ref, first_placeholder, params_have_prompt, params_have_session, text_has_prompt,
    text_has_session,
};
use super::types::{RawStep, WaitDone};

const SESSION_STDIN_ONLY: &str = "{session}/{session_file} only allowed in stdin";

/// Flattened executable step — `FlatStep` in `src/workflows/errors.ts`.
/// `Option` fields mirror optional object keys (`timeout_ms` is set only when
/// the step waits); `wait`/`close_source` mirror `wait?: true` / `closeSource?: true`.
#[derive(Debug, Clone, PartialEq)]
pub enum FlatStep {
    Shell {
        command: String,
        stdin: Option<String>,
    },
    Open {
        command: String,
        wait_for: Option<String>,
        timeout_ms: Option<u64>,
    },
    Agent {
        name: String,
        prompt: Option<String>,
        wait: bool,
        timeout_ms: Option<u64>,
        close_source: bool,
    },
    Herdr {
        method: String,
        params: Option<BTreeMap<String, serde_json::Value>>,
    },
}

fn ban_placeholder(file: &str, step: usize, command: &str) -> Result<(), WorkflowLoadError> {
    let Some(ph) = first_placeholder(command) else {
        return Ok(());
    };
    if ph == "session" || ph == "session_file" {
        return Err(WorkflowLoadError(positioned(
            file,
            Some(step),
            None,
            SESSION_STDIN_ONLY,
        )));
    }
    Err(WorkflowLoadError(positioned(
        file,
        Some(step),
        None,
        &format!("placeholder {{{ph}}} not allowed in command strings (use stdin/prompt/params)"),
    )))
}

fn ban_session_outside_stdin(
    file: &str,
    step: usize,
    key: Option<&str>,
    text: Option<&str>,
) -> Result<(), WorkflowLoadError> {
    if let Some(text) = text {
        if text_has_session(text) {
            return Err(WorkflowLoadError(positioned(
                file,
                Some(step),
                key,
                SESSION_STDIN_ONLY,
            )));
        }
    }
    Ok(())
}

/// `rawToFlat`; `step_index` is 1-based. A `run` step means flatten (task 1.5)
/// did not run first — an internal error, same as the TS throw.
///
/// # Errors
/// `WorkflowLoadError` for placeholders in command strings, `{session}` outside
/// `stdin`, or an unflattened `run` step.
pub fn raw_to_flat(
    file: &str,
    step_index: usize,
    step: &RawStep,
) -> Result<FlatStep, WorkflowLoadError> {
    if let Some(command) = &step.shell {
        ban_placeholder(file, step_index, command)?;
        return Ok(FlatStep::Shell {
            command: command.clone(),
            stdin: step.stdin.clone(),
        });
    }
    if let Some(command) = &step.open {
        ban_placeholder(file, step_index, command)?;
        if let Some(wait_for) = &step.wait_for {
            return Ok(FlatStep::Open {
                command: command.clone(),
                wait_for: Some(wait_for.clone()),
                timeout_ms: Some(step.timeout.unwrap_or(60) * 1000),
            });
        }
        return Ok(FlatStep::Open {
            command: command.clone(),
            wait_for: None,
            timeout_ms: None,
        });
    }
    if let Some(name) = &step.agent {
        ban_session_outside_stdin(file, step_index, Some("prompt"), step.prompt.as_deref())?;
        let close_source = step.close_source == Some(true);
        if step.wait == Some(WaitDone::Done) {
            return Ok(FlatStep::Agent {
                name: name.clone(),
                prompt: step.prompt.clone(),
                wait: true,
                timeout_ms: Some(step.timeout.unwrap_or(1800) * 1000),
                close_source,
            });
        }
        return Ok(FlatStep::Agent {
            name: name.clone(),
            prompt: step.prompt.clone(),
            wait: false,
            timeout_ms: None,
            close_source,
        });
    }
    if let Some(method) = &step.herdr {
        if params_have_session(step.params.as_ref()) {
            return Err(WorkflowLoadError(positioned(
                file,
                Some(step_index),
                Some("params"),
                SESSION_STDIN_ONLY,
            )));
        }
        return Ok(FlatStep::Herdr {
            method: method.clone(),
            params: step.params.clone(),
        });
    }
    Err(WorkflowLoadError(positioned(
        file,
        Some(step_index),
        Some("run"),
        "internal: run not flattened",
    )))
}

/// `checkAgents` — agent names must be config agents, `{agent}`, or `{input.*}`
/// (input refs are validated against declared inputs by `checkInputRefs`, task 1.5).
///
/// # Errors
/// `WorkflowLoadError` on the first unknown agent, at its 1-based step position.
pub fn check_agents(
    file: &str,
    steps: &[FlatStep],
    agents: &HashSet<String>,
) -> Result<(), WorkflowLoadError> {
    for (idx, step) in steps.iter().enumerate() {
        let FlatStep::Agent { name, .. } = step else {
            continue;
        };
        if name == "{agent}" || agent_input_ref(name).is_some() || agents.contains(name) {
            continue;
        }
        return Err(WorkflowLoadError(positioned(
            file,
            Some(idx + 1),
            Some("agent"),
            &format!("unknown agent '{name}'"),
        )));
    }
    Ok(())
}

/// `flatNeedsPrompt`.
pub fn flat_needs_prompt(steps: &[FlatStep]) -> bool {
    steps.iter().any(|s| match s {
        FlatStep::Shell {
            stdin: Some(stdin), ..
        } => text_has_prompt(stdin),
        FlatStep::Agent {
            prompt: Some(prompt),
            ..
        } => text_has_prompt(prompt),
        FlatStep::Herdr { params, .. } => params_have_prompt(params.as_ref()),
        _ => false,
    })
}

/// `flatNeedsSession`.
pub fn flat_needs_session(steps: &[FlatStep]) -> bool {
    steps
        .iter()
        .any(|s| matches!(s, FlatStep::Shell { stdin: Some(stdin), .. } if text_has_session(stdin)))
}

/// `flatNeedsInvokingAgent` — any agent step bound to the invoking pane's agent.
pub fn flat_needs_invoking_agent(steps: &[FlatStep]) -> bool {
    steps
        .iter()
        .any(|s| matches!(s, FlatStep::Agent { name, .. } if name == "{agent}"))
}
