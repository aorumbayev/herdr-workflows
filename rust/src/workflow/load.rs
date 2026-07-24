//! Full loader composition. Port of `src/workflows/load.ts`:
//! `loadFromRaw` → `parseWorkflowText` / `loadWorkflow` / `loadWorkflowEntry`
//! / `listWorkflows`.

use std::collections::HashSet;

use super::discover::{Resolved, WorkflowDirs, collect_workflow_entries, resolve_workflow_file};
use super::errors::{InputSpec, Source, WorkflowListEntry, WorkflowLoadError, positioned};
use super::flatten::{flatten_steps, parse_file};
use super::inputs::{check_input_refs, resolve_inputs};
use super::parse::parse_raw;
use super::recovery::{assert_no_on_fail, load_recovery};
use super::steps::{
    FlatStep, check_agents, flat_needs_invoking_agent, flat_needs_prompt, flat_needs_session,
};
use super::types::RawWorkflow;

/// Flattened `on_fail` target — `recovery` on TS `LoadedWorkflow`.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoverySteps {
    pub name: String,
    pub steps: Vec<FlatStep>,
}

/// A fully loaded workflow — `LoadedWorkflow` in `src/workflows/errors.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedWorkflow {
    pub name: String,
    pub file: String,
    pub steps: Vec<FlatStep>,
    pub inputs: Vec<InputSpec>,
    pub on_fail: Option<String>,
    pub recovery: Option<RecoverySteps>,
    pub repo_owned: bool,
    pub needs_prompt: bool,
    pub needs_session: bool,
    pub needs_invoking_agent: bool,
}

/// `loadFromRaw`: the whole pipeline over an already-parsed document —
/// `assertNoOnFail` on entry `run` steps, flatten, agent check, input
/// resolution + reference check, recovery load, unused-input check.
fn load_from_raw(
    name: &str,
    file: &str,
    source: Source,
    raw: &RawWorkflow,
    dirs: &WorkflowDirs,
    agents: &HashSet<String>,
    resolve_dynamic: bool,
) -> Result<LoadedWorkflow, WorkflowLoadError> {
    let mut sources: HashSet<Source> = HashSet::from([source]);
    for (i, step) in raw.steps.iter().enumerate() {
        if let Some(run) = &step.run {
            assert_no_on_fail(run, dirs, file, i + 1, &mut HashSet::new())?;
        }
    }

    let steps = flatten_steps(
        name,
        dirs,
        &[],
        Some(&mut sources),
        Some((file, source)),
        Some(raw),
    )?;
    check_agents(file, &steps, agents)?;
    let inputs = resolve_inputs(file, raw, agents, &dirs.repo_root, resolve_dynamic)?;
    let mut used = check_input_refs(file, &inputs, &steps, agents)?;
    let mut needs_prompt = flat_needs_prompt(&steps);
    let mut needs_session = flat_needs_session(&steps);
    let mut needs_invoking_agent = flat_needs_invoking_agent(&steps);
    let mut recovery_steps = None;
    if let Some(on_fail) = &raw.on_fail {
        let recovery = load_recovery(file, on_fail, dirs, agents, Some(&mut sources))?;
        used.extend(check_input_refs(file, &inputs, &recovery, agents)?);
        needs_prompt |= flat_needs_prompt(&recovery);
        needs_session |= flat_needs_session(&recovery);
        needs_invoking_agent |= flat_needs_invoking_agent(&recovery);
        recovery_steps = Some(recovery);
    }
    for spec in &inputs {
        if !used.contains(&spec.name) {
            return Err(WorkflowLoadError(positioned(
                file,
                None,
                Some(&format!("inputs.{}", spec.name)),
                "declared but never referenced",
            )));
        }
    }
    Ok(LoadedWorkflow {
        name: name.to_string(),
        file: file.to_string(),
        steps,
        inputs,
        on_fail: raw.on_fail.clone(),
        recovery: recovery_steps.map(|steps| RecoverySteps {
            name: raw.on_fail.clone().expect("recovery implies on_fail"),
            steps,
        }),
        repo_owned: sources.contains(&Source::Repo),
        needs_prompt,
        needs_session,
        needs_invoking_agent,
    })
}

/// `loadResolvedWorkflow`: parse the resolved file, then `loadFromRaw` with
/// the file path as the error label.
fn load_resolved_workflow(
    name: &str,
    dirs: &WorkflowDirs,
    agents: &HashSet<String>,
    resolved: &Resolved,
    resolve_dynamic: bool,
) -> Result<LoadedWorkflow, WorkflowLoadError> {
    let parsed = parse_file(&resolved.file)?;
    load_from_raw(
        name,
        &resolved.file,
        resolved.source,
        &parsed.raw,
        dirs,
        agents,
        resolve_dynamic,
    )
}

/// `parseWorkflowText`: validate an in-memory YAML buffer through the exact
/// file-load path so buffer and file validation produce identical positioned
/// errors. `file` is the label used in those errors (the TS default is
/// `<name>.yaml`); splices and dynamic options resolve against `dirs`.
///
/// # Errors
/// `WorkflowLoadError` for any load-pipeline failure.
pub fn parse_workflow_text(
    name: &str,
    yaml: &str,
    agents: &HashSet<String>,
    dirs: &WorkflowDirs,
    file: &str,
    resolve_dynamic: bool,
) -> Result<LoadedWorkflow, WorkflowLoadError> {
    let raw = parse_raw(file, yaml)?;
    load_from_raw(
        name,
        file,
        Source::Repo,
        &raw,
        dirs,
        agents,
        resolve_dynamic,
    )
}

/// `loadWorkflow`: resolve by name (repo shadows global) and load with
/// dynamic options executed.
///
/// # Errors
/// `WorkflowLoadError` when the name resolves nowhere or the load fails.
pub fn load_workflow(
    name: &str,
    dirs: &WorkflowDirs,
    agents: &HashSet<String>,
) -> Result<LoadedWorkflow, WorkflowLoadError> {
    let Some(resolved) = resolve_workflow_file(name, dirs) else {
        return Err(WorkflowLoadError(format!("workflow '{name}' not found")));
    };
    load_resolved_workflow(name, dirs, agents, &resolved, true)
}

/// `loadWorkflowEntry`: load the exact file the entry points at — never
/// re-resolve by name, so a repo shadow cannot replace a global entry.
///
/// # Errors
/// `WorkflowLoadError` when the entry's file fails to load.
pub fn load_workflow_entry(
    entry: &WorkflowListEntry,
    dirs: &WorkflowDirs,
    agents: &HashSet<String>,
    resolve_dynamic: bool,
) -> Result<LoadedWorkflow, WorkflowLoadError> {
    let resolved = Resolved {
        file: entry.file.clone(),
        source: entry.source,
    };
    load_resolved_workflow(&entry.name, dirs, agents, &resolved, resolve_dynamic)
}

/// `listWorkflows`: discover every workflow, validating each with dynamic
/// options left unexecuted. Failures are recorded on the entry (`error`)
/// instead of aborting the list — the picker dims those rows.
#[must_use]
pub fn list_workflows(dirs: &WorkflowDirs, agents: &HashSet<String>) -> Vec<WorkflowListEntry> {
    let mut entries = collect_workflow_entries(dirs);
    for entry in &mut entries {
        match load_workflow_entry(entry, dirs, agents, false) {
            Ok(workflow) => {
                entry.needs_prompt = Some(workflow.needs_prompt);
                entry.dynamic_options =
                    Some(workflow.inputs.iter().any(|input| input.dynamic_options));
                entry.inputs = Some(workflow.inputs);
                entry.repo_owned = Some(workflow.repo_owned);
            }
            Err(error) => entry.error = Some(error.to_string()),
        }
    }
    entries
}
