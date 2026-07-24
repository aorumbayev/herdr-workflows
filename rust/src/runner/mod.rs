//! Step dispatch, shell execution, preflight, agent-wait, runlog.
//! Port of `src/runner/` + `src/runner.ts` (tasks 2.4-2.5).
//!
//! - `deps`: the runner↔herdr trait seam (design D5) + shared step types.
//! - `dispatch`: the sequential step loop; `fire`: pane-creating steps.
//! - `spawn`: the shared subprocess helper (`sh -c` capture + group kill),
//!   also used by `workflow::inputs` and `runner::session`.
//! - `context`: invocation env + display sanitizer; `session`: per-agent
//!   transcript extraction; `runlog`: JSONL observability.
//! - [`run_workflow`]: the `run` entry the CLI arm calls.

pub mod agent_wait;
pub mod context;
pub mod deps;
pub mod dispatch;
pub mod fire;
pub mod inputs;
pub mod preflight;
pub mod runlog;
pub mod session;
pub mod shell;
pub mod spawn;

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use deps::StepRunOptions;
pub use deps::{Herdr, LiveHerdr, StepResult};
use runlog::{RunLog, RunLogEntry, iso_now};

use crate::config::{AgentsConfig, SessionsConfig};
use crate::herdr::cli::PaneReadOpts;
use crate::workflow::discover::WorkflowDirs;
use crate::workflow::errors::WorkflowLoadError;
use crate::workflow::load::{LoadedWorkflow, load_workflow};
use crate::workflow::substitute::PlaceholderValues;

/// `RunOptions` — everything `hwf run <name>` needs. `workflow` pre-loads
/// the workflow (web/picker pass their already-listed entry); `wait_clock`
/// overrides the agent-wait clock in tests.
pub struct RunOptions<'a> {
    pub name: &'a str,
    pub repo_root: &'a Path,
    pub agents: &'a AgentsConfig,
    pub sessions: &'a SessionsConfig,
    pub ctx: &'a context::InvocationContext,
    pub prompt: Option<&'a str>,
    pub inputs: BTreeMap<String, String>,
    pub workflow: Option<&'a LoadedWorkflow>,
    pub herdr: &'a dyn Herdr,
    pub run_log: &'a RunLog,
    pub wait_clock: Option<&'a agent_wait::AgentWaitClock>,
    pub on_progress: Option<deps::ProgressCallback<'a>>,
    pub on_stderr: Option<&'a dyn Fn(&str)>,
}

/// `buildPlaceholders` — invocation snapshot for substitution. A pane-read
/// failure yields an empty `{pane}`, as the TS `.catch(() => "")`.
fn build_placeholders(
    herdr: &dyn Herdr,
    opts: &RunOptions,
    session: &str,
    session_file: &str,
    agent: &str,
    inputs: BTreeMap<String, String>,
) -> PlaceholderValues {
    let mut pane = String::new();
    if let Some(pane_id) = &opts.ctx.pane_id {
        if let Ok(scrollback) = herdr.pane_read(
            pane_id,
            PaneReadOpts {
                source: Some(context::PANE_READ_SOURCE),
                lines: Some(context::PANE_READ_LINES),
            },
        ) {
            pane = context::sanitize_display(&scrollback);
        }
    }
    PlaceholderValues {
        pane,
        selection: context::sanitize_display(&opts.ctx.selection),
        prompt: opts.prompt.unwrap_or_default().to_string(),
        last: String::new(),
        error: String::new(),
        session: session.to_string(),
        session_file: session_file.to_string(),
        tab: String::new(),
        prev_tab: String::new(),
        agent: agent.to_string(),
        inputs,
    }
}

fn run_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    uuid[..8].to_string()
}

/// `runWorkflow` — load, resolve inputs + preflight, run steps, run
/// `on_fail` recovery on failure, log + clean up. Precondition failures
/// notify with `step 0` and never run recovery (the TS `failPrecondition`).
///
/// # Errors
/// `WorkflowLoadError` when the workflow fails to load (the CLI prints the
/// positioned message and dies).
pub fn run_workflow(opts: &RunOptions) -> Result<StepResult, WorkflowLoadError> {
    let run_id = run_id();
    let loaded;
    let workflow = match opts.workflow {
        Some(workflow) => workflow,
        None => {
            let dirs = WorkflowDirs::for_repo(opts.repo_root);
            let agent_names: HashSet<String> = opts.agents.keys().cloned().collect();
            loaded = load_workflow(opts.name, &dirs, &agent_names)?;
            &loaded
        }
    };

    let default_clock;
    let wait_clock = match opts.wait_clock {
        Some(clock) => clock,
        None => {
            default_clock = agent_wait::AgentWaitClock::default();
            &default_clock
        }
    };
    let step_opts = StepRunOptions {
        name: &workflow.name,
        agents: opts.agents,
        ctx: opts.ctx,
        herdr: opts.herdr,
        run_log: opts.run_log,
        run_id: &run_id,
        wait_clock,
        on_progress: opts.on_progress,
        on_stderr: opts.on_stderr,
    };

    let fail_precondition = |detail: &str| -> StepResult {
        let error = fire::fail(opts.herdr, &workflow.name, 0, detail);
        opts.run_log.append(&RunLogEntry {
            ts: iso_now(),
            run: run_id.clone(),
            workflow: workflow.name.clone(),
            step: None,
            total: None,
            label: None,
            ok: false,
            error: Some(error.clone()),
        });
        StepResult::failed(error, String::new())
    };

    let mut session_file = String::new();
    let result = 'run: {
        let inputs = match inputs::resolve_input_values(&workflow.inputs, &opts.inputs) {
            Ok(values) => values,
            Err(detail) => break 'run fail_precondition(&detail),
        };
        let (session, session_failure, agent) = match preflight::resolve_preflight(
            workflow,
            opts.ctx,
            opts.agents,
            opts.sessions,
            opts.herdr,
        ) {
            preflight::Preflight::Ok {
                session,
                session_failure,
                agent,
            } => (session, session_failure, agent),
            preflight::Preflight::Err(detail) => break 'run fail_precondition(&detail),
        };

        // {session_file}: transcript spliced as text into a shell script can
        // break its quoting/heredocs, so offer it as a file path instead.
        // Valid for the run only.
        if !session.is_empty() {
            session_file = std::env::temp_dir()
                .join(format!("hwf-session-{run_id}.txt"))
                .display()
                .to_string();
            if std::fs::write(&session_file, &session).is_err() {
                session_file = String::new();
            }
        }

        let base = build_placeholders(opts.herdr, opts, &session, &session_file, &agent, inputs);

        let primary = match session_failure {
            Some(failure) => {
                let error = fire::fail(opts.herdr, &workflow.name, 0, &failure);
                StepResult::failed(error, String::new())
            }
            None => dispatch::run_steps(&workflow.steps, &step_opts, &base),
        };
        let mut result = primary;
        if !result.ok
            && let Some(recovery) = &workflow.recovery
        {
            // Same invocation snapshot into recovery — re-reading {pane} here
            // would capture post-failure scrollback.
            let recovery_values = PlaceholderValues {
                last: result.last.clone(),
                error: result.error.clone().unwrap_or_default(),
                ..base
            };
            let recovery_opts = StepRunOptions {
                name: &recovery.name,
                ..step_opts
            };
            result = dispatch::run_steps(&recovery.steps, &recovery_opts, &recovery_values);
        }
        opts.run_log.append(&RunLogEntry {
            ts: iso_now(),
            run: run_id.clone(),
            workflow: workflow.name.clone(),
            step: None,
            total: None,
            label: None,
            ok: result.ok,
            error: result.error.clone(),
        });
        result
    };

    // TS `finally`: session file removed, progress token cleared.
    if !session_file.is_empty() {
        let _ = std::fs::remove_file(&session_file);
    }
    if let Some(pane_id) = &opts.ctx.pane_id {
        let _ = opts.herdr.report_token(pane_id, None);
    }
    Ok(result)
}
