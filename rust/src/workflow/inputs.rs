//! Input resolution + `checkInputRefs`. Port of `src/workflows/inputs.ts`.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use super::errors::{InputSpec, WorkflowLoadError, positioned};
use super::placeholder::{agent_input_ref, params_input_refs, text_input_refs};
use super::steps::FlatStep;
use super::types::{RawOptions, RawWorkflow};
use crate::runner::spawn::{self, SpawnOpts};

const OPTIONS_CMD_TIMEOUT: Duration = Duration::from_millis(5_000);
const AGENTS_BUILTIN: &str = "agents";

/// Options-command capture via the shared helper in `crate::runner::spawn`
/// (`sh -c`, no stdin, inherited env).
fn spawn_capture(command: &str, cwd: &Path, timeout: Duration) -> std::io::Result<spawn::Capture> {
    let argv = vec!["sh".to_string(), "-c".to_string(), command.to_string()];
    spawn::spawn_capture(
        &argv,
        &SpawnOpts {
            cwd,
            stdin: None,
            env: &[],
            timeout,
        },
    )
}

/// `resolveOptionLines`: run the options command, map timeout/nonzero/empty
/// to the pinned load errors.
fn resolve_option_lines(
    file: &str,
    input_name: &str,
    command: &str,
    repo_root: &Path,
) -> Result<Vec<String>, WorkflowLoadError> {
    let key = format!("inputs.{input_name}");
    let result = spawn_capture(command, repo_root, OPTIONS_CMD_TIMEOUT).map_err(|e| {
        WorkflowLoadError(positioned(
            file,
            None,
            Some(&key),
            &format!("options command failed: {e}"),
        ))
    })?;
    if result.timed_out {
        return Err(WorkflowLoadError(positioned(
            file,
            None,
            Some(&key),
            &format!(
                "options command timed out after {}s",
                OPTIONS_CMD_TIMEOUT.as_secs()
            ),
        )));
    }
    if result.exit_code != 0 {
        let detail = result.stderr.trim();
        let detail = if detail.is_empty() {
            format!("exit {}", result.exit_code)
        } else {
            detail.to_string()
        };
        return Err(WorkflowLoadError(positioned(
            file,
            None,
            Some(&key),
            &format!("options command failed: {detail}"),
        )));
    }
    let lines: Vec<String> = result
        .stdout
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if lines.is_empty() {
        return Err(WorkflowLoadError(positioned(
            file,
            None,
            Some(&key),
            "options command produced no choices",
        )));
    }
    Ok(lines)
}

/// `resolveInputs`: declaration order, `agents` builtin, dynamic option
/// commands (executed only when `resolve_dynamic`), default membership.
///
/// The `agents` builtin expands sorted: TS preserves config insertion order,
/// but the Rust config port (`BTreeMap`) is sorted, so sorted matches what
/// callers here actually hold.
///
/// # Errors
/// `WorkflowLoadError` for the agents-sentinel-without-agents, options-command
/// failures, or a default outside the resolved options.
pub fn resolve_inputs(
    file: &str,
    raw: &RawWorkflow,
    agents: &HashSet<String>,
    repo_root: &Path,
    resolve_dynamic: bool,
) -> Result<Vec<InputSpec>, WorkflowLoadError> {
    let mut specs = Vec::with_capacity(raw.input_order.len());
    for name in &raw.input_order {
        let input = raw
            .inputs
            .as_ref()
            .and_then(|inputs| inputs.get(name))
            .expect("input_order entries exist in inputs");
        let key = format!("inputs.{name}");
        let mut options: Option<Vec<String>> = None;
        match &input.options {
            None => {}
            Some(RawOptions::Choices(choices)) => options = Some(choices.clone()),
            Some(RawOptions::Command(command)) if command == AGENTS_BUILTIN => {
                if agents.is_empty() {
                    return Err(WorkflowLoadError(positioned(
                        file,
                        None,
                        Some(&key),
                        "options: agents but no agents configured",
                    )));
                }
                let mut expanded: Vec<String> = agents.iter().cloned().collect();
                expanded.sort();
                options = Some(expanded);
            }
            Some(RawOptions::Command(command)) => {
                if resolve_dynamic {
                    options = Some(resolve_option_lines(file, name, command, repo_root)?);
                }
            }
        }
        if let (Some(options), Some(default)) = (&options, &input.default) {
            if !options.contains(default) {
                return Err(WorkflowLoadError(positioned(
                    file,
                    None,
                    Some(&key),
                    &format!("default '{default}' not in options"),
                )));
            }
        }
        let dynamic_options = matches!(&input.options, Some(RawOptions::Command(command)) if command != AGENTS_BUILTIN)
            && !resolve_dynamic;
        specs.push(InputSpec {
            name: name.clone(),
            label: input.label.clone().unwrap_or_else(|| name.clone()),
            options,
            dynamic_options,
            default: input.default.clone(),
        });
    }
    Ok(specs)
}

/// `checkAgentInput`: an input driving `agent:` must resolve to config agents.
fn check_agent_input(
    file: &str,
    idx: usize,
    spec: &InputSpec,
    agents: &HashSet<String>,
) -> Result<(), WorkflowLoadError> {
    if spec.dynamic_options {
        return Ok(());
    }
    let Some(options) = &spec.options else {
        return Err(WorkflowLoadError(positioned(
            file,
            Some(idx + 1),
            Some("agent"),
            &format!("input '{}' needs options: to be used as agent", spec.name),
        )));
    };
    for option in options {
        if !agents.contains(option) {
            return Err(WorkflowLoadError(positioned(
                file,
                Some(idx + 1),
                Some("agent"),
                &format!(
                    "input '{}' option '{}' is not a config agent",
                    spec.name, option
                ),
            )));
        }
    }
    Ok(())
}

/// `require` in TS: look up a declared input, mark it used.
fn require<'a>(
    file: &str,
    inputs: &'a [InputSpec],
    name: &str,
    idx: usize,
    key: Option<&str>,
    used: &mut HashSet<String>,
) -> Result<&'a InputSpec, WorkflowLoadError> {
    let Some(spec) = inputs.iter().find(|spec| spec.name == name) else {
        return Err(WorkflowLoadError(positioned(
            file,
            Some(idx + 1),
            key,
            &format!("undeclared input '{{input.{name}}}' — declare it under inputs:"),
        )));
    };
    used.insert(name.to_string());
    Ok(spec)
}

/// `checkInputRefs`: every `{input.*}` reference must be declared; returns the
/// set of inputs that were referenced (stdin/prompt/params refs, `HWF_INPUT_*`
/// mentions in shell commands, agent-position refs).
///
/// # Errors
/// `WorkflowLoadError` on the first undeclared reference or agent-input misuse.
pub fn check_input_refs(
    file: &str,
    inputs: &[InputSpec],
    steps: &[FlatStep],
    agents: &HashSet<String>,
) -> Result<HashSet<String>, WorkflowLoadError> {
    let mut used = HashSet::new();
    for (idx, step) in steps.iter().enumerate() {
        match step {
            FlatStep::Shell { command, stdin } => {
                for name in text_input_refs(stdin.as_deref().unwrap_or("")) {
                    require(file, inputs, &name, idx, Some("stdin"), &mut used)?;
                }
                for spec in inputs {
                    if command.contains(&format!("HWF_INPUT_{}", spec.name)) {
                        require(file, inputs, &spec.name, idx, None, &mut used)?;
                    }
                }
            }
            FlatStep::Herdr { params, .. } => {
                for name in params_input_refs(params.as_ref()) {
                    require(file, inputs, &name, idx, Some("params"), &mut used)?;
                }
            }
            FlatStep::Agent { name, prompt, .. } => {
                for input_name in text_input_refs(prompt.as_deref().unwrap_or("")) {
                    require(file, inputs, &input_name, idx, Some("prompt"), &mut used)?;
                }
                if let Some(input_name) = agent_input_ref(name) {
                    let spec = require(file, inputs, &input_name, idx, Some("agent"), &mut used)?;
                    check_agent_input(file, idx, spec, agents)?;
                }
            }
            FlatStep::Open { .. } => {}
        }
    }
    Ok(used)
}
