//! Sequential step loop. Port of `src/runner/dispatch.ts`: per-step
//! progress + token, `{last}`/`{tab}`/`{prev_tab}` threading, run-log
//! entries, stop-on-first-failure.

use super::deps::{StepResult, StepRunOptions, input_env};
use super::fire::{fail, fire};
use super::runlog::{RunLogEntry, iso_now};
use super::shell::run_shell_step;
use crate::workflow::steps::FlatStep;
use crate::workflow::substitute::{PlaceholderValues, substitute};

/// `stepLabel`.
fn step_label(step: &FlatStep) -> String {
    match step {
        FlatStep::Shell { command, .. } => format!("shell: {command}"),
        FlatStep::Open { command, .. } => format!("open: {command}"),
        FlatStep::Agent { name, .. } => format!("agent: {name}"),
        FlatStep::Herdr { method, .. } => format!("herdr: {method}"),
    }
}

/// `pushTab` — new tab becomes `{tab}`, old `{tab}` shifts to `{prev_tab}`.
fn push_tab(current: &PlaceholderValues, tab: String, last: &str) -> PlaceholderValues {
    let mut next = current.clone();
    next.last = last.to_string();
    next.prev_tab = std::mem::replace(&mut next.tab, tab);
    next
}

/// `runSteps` — run every step in order; the first failure stops the
/// sequence and its notified message becomes the result error.
pub fn run_steps(
    steps: &[FlatStep],
    opts: &StepRunOptions,
    values: &PlaceholderValues,
) -> StepResult {
    let mut last = values.last.clone();
    let mut tab = values.tab.clone();
    let mut prev_tab = values.prev_tab.clone();
    let total = steps.len();
    let pane_id = opts.ctx.pane_id.as_deref();
    let log_step = |step: usize, label: &str, error: Option<&str>| {
        opts.run_log.append(&RunLogEntry {
            ts: iso_now(),
            run: opts.run_id.to_string(),
            workflow: opts.name.to_string(),
            step: Some(step as u32),
            total: Some(total as u32),
            label: Some(label.to_string()),
            ok: error.is_none(),
            error: error.map(str::to_string),
        });
    };

    for (idx, step) in steps.iter().enumerate() {
        let i = idx + 1;
        let label = step_label(step);
        if let Some(on_progress) = opts.on_progress {
            on_progress(i, total, &label);
        }
        if let Some(pane_id) = pane_id {
            let _ = opts
                .herdr
                .report_token(pane_id, Some(&format!("{} {i}/{total}", opts.name)));
        }
        let current = PlaceholderValues {
            last: last.clone(),
            tab: tab.clone(),
            prev_tab: prev_tab.clone(),
            ..values.clone()
        };
        if let FlatStep::Shell { command, stdin } = step {
            let stdin = stdin.as_deref().map(|text| substitute(text, &current));
            let result = match run_shell_step(
                command,
                std::path::Path::new(&opts.ctx.cwd),
                stdin.as_deref(),
                &input_env(&current.inputs),
                None,
            ) {
                Ok(result) => result,
                Err(spawn_error) => {
                    let error = fail(opts.herdr, opts.name, i, &spawn_error.message);
                    log_step(i, &label, Some(&error));
                    return StepResult::failed(error, last);
                }
            };
            if !result.stderr.is_empty()
                && let Some(on_stderr) = opts.on_stderr
            {
                on_stderr(&result.stderr);
            }
            if !result.ok {
                let detail = if result.stderr.trim().is_empty() {
                    "nonzero exit"
                } else {
                    result.stderr.trim()
                };
                let error = fail(opts.herdr, opts.name, i, detail);
                log_step(i, &label, Some(&error));
                return StepResult::failed(error, last);
            }
            last = result.stdout;
            log_step(i, &label, None);
            continue;
        }
        let outcome = fire(opts, step, &current, i, &last);
        if let Some(failed) = outcome.failed {
            log_step(i, &label, failed.error.as_deref());
            return failed;
        }
        if let Some(text) = outcome.last {
            last = text;
        }
        if let Some(tab_id) = outcome.tab_id {
            let next = push_tab(&current, tab_id, &last);
            tab = next.tab;
            prev_tab = next.prev_tab;
        }
        log_step(i, &label, None);
    }
    StepResult::ok(last)
}
