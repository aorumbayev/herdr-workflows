//! `on_fail` rules. Port of `src/workflows/recovery.ts`.

use std::collections::HashSet;

use super::discover::{WorkflowDirs, resolve_workflow_file};
use super::errors::{Source, WorkflowLoadError, positioned};
use super::flatten::{flatten_steps, parse_file};
use super::steps::{FlatStep, check_agents};

/// `assertNoOnFail`: `run` targets (transitively) must not declare `on_fail`.
/// `step` is the entry-side position used in error labels — `0` from
/// `load_recovery`, which TS deliberately passes through to the positioned
/// string (`step 0`), a quirk pinned by the golden corpus.
///
/// # Errors
/// `WorkflowLoadError` on unknown targets or a target declaring `on_fail`.
pub fn assert_no_on_fail(
    name: &str,
    dirs: &WorkflowDirs,
    from_file: &str,
    step: usize,
    seen: &mut HashSet<String>,
) -> Result<(), WorkflowLoadError> {
    if !seen.insert(name.to_string()) {
        return Ok(());
    }
    let Some(resolved) = resolve_workflow_file(name, dirs) else {
        return Err(WorkflowLoadError(positioned(
            from_file,
            Some(step),
            Some("run"),
            &format!("unknown workflow '{name}'"),
        )));
    };
    let parsed = parse_file(&resolved.file)?;
    if parsed.raw.on_fail.is_some() {
        return Err(WorkflowLoadError(positioned(
            from_file,
            Some(step),
            Some("on_fail"),
            &format!("run target '{name}' declares on_fail"),
        )));
    }
    for s in &parsed.raw.steps {
        if let Some(run) = &s.run {
            assert_no_on_fail(run, dirs, from_file, step, seen)?;
        }
    }
    Ok(())
}

/// `loadRecovery`: resolve, validate, and flatten the `on_fail` target.
/// Recovery targets may not declare `on_fail` or `inputs`; their steps are
/// agent-checked against the entry file's label.
///
/// # Errors
/// `WorkflowLoadError` on unknown target, target `on_fail`/`inputs`, or any
/// error from flattening the target.
pub fn load_recovery(
    entry_file: &str,
    on_fail: &str,
    dirs: &WorkflowDirs,
    agents: &HashSet<String>,
    mut sources: Option<&mut HashSet<Source>>,
) -> Result<Vec<FlatStep>, WorkflowLoadError> {
    let Some(resolved) = resolve_workflow_file(on_fail, dirs) else {
        return Err(WorkflowLoadError(positioned(
            entry_file,
            None,
            Some("on_fail"),
            &format!("unknown workflow '{on_fail}'"),
        )));
    };
    let parsed = parse_file(&resolved.file)?;
    if let Some(sources) = sources.as_deref_mut() {
        sources.insert(resolved.source);
    }
    if parsed.raw.on_fail.is_some() {
        return Err(WorkflowLoadError(positioned(
            entry_file,
            None,
            Some("on_fail"),
            &format!("recovery target '{on_fail}' declares on_fail"),
        )));
    }
    if parsed.raw.inputs.is_some() {
        return Err(WorkflowLoadError(positioned(
            entry_file,
            None,
            Some("on_fail"),
            &format!(
                "recovery target '{on_fail}' declares inputs — declare them on the entry workflow"
            ),
        )));
    }
    for step in &parsed.raw.steps {
        if let Some(run) = &step.run {
            assert_no_on_fail(run, dirs, &resolved.file, 0, &mut HashSet::new())?;
        }
    }
    let steps = flatten_steps(on_fail, dirs, &[], sources, None, None)?;
    check_agents(entry_file, &steps, agents)?;
    Ok(steps)
}
