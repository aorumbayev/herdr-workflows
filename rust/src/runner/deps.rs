//! Runner↔herdr seam (design D5). The single trait the runner depends on;
//! tests fake it, production uses [`LiveHerdr`], which composes
//! `herdr::cli` / `herdr::rpc` / `runner::session`. Also the shared step
//! types — `RunnerDeps`/`StepResult`/`StepRunOptions` in `src/runner/types.ts`.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::agent_wait::AgentWaitClock;
use super::context::InvocationContext;
use super::runlog::RunLog;
use crate::config::{AgentsConfig, SessionsConfig};
use crate::herdr::cli::{self, LayoutApplyParams, LayoutApplyResult, PaneReadOpts};
use crate::herdr::rpc::HerdrError;

/// Everything the runner needs from herdr. One method per `RunnerDeps` key
/// in TS; shell execution is *not* here (it isn't herdr — tests use the
/// real `sh`, as the TS suite does).
pub trait Herdr {
    /// `layoutApply` (socket).
    fn layout_apply(&self, params: &LayoutApplyParams) -> Result<LayoutApplyResult, HerdrError>;
    /// Raw `herdrCall` for `herdr:` steps.
    fn herdr_call(&self, method: &str, params: Map<String, Value>) -> Result<Value, HerdrError>;
    /// `notificationShow`.
    fn notification_show(&self, title: &str, body: Option<&str>) -> Result<(), HerdrError>;
    /// `agentStatus` (`working` / `idle` / `blocked` / `done`).
    fn agent_status(&self, pane_id: &str) -> Result<String, HerdrError>;
    /// `agentLabel`.
    fn agent_label(&self, pane_id: &str) -> Result<String, HerdrError>;
    /// `waitOutput`.
    fn wait_output(&self, pane_id: &str, regex: &str, timeout_ms: u64) -> Result<(), HerdrError>;
    /// `paneRead`.
    fn pane_read(&self, pane_id: &str, opts: PaneReadOpts) -> Result<String, HerdrError>;
    /// `reportToken`; `None` clears.
    fn report_token(&self, pane_id: &str, value: Option<&str>) -> Result<(), HerdrError>;
    /// `sessionText` with the default wiring (live `agent get`, default
    /// transcript root).
    fn session_text(&self, pane_id: &str, sessions: &SessionsConfig) -> Result<String, HerdrError>;
    /// `tabClose`.
    fn tab_close(&self, tab_id: &str) -> Result<(), HerdrError>;
}

/// Production implementation over the real herdr adapters.
pub struct LiveHerdr;

impl Herdr for LiveHerdr {
    fn layout_apply(&self, params: &LayoutApplyParams) -> Result<LayoutApplyResult, HerdrError> {
        cli::layout_apply(params)
    }

    fn herdr_call(&self, method: &str, params: Map<String, Value>) -> Result<Value, HerdrError> {
        crate::herdr::rpc::herdr_call(method, &params)
    }

    fn notification_show(&self, title: &str, body: Option<&str>) -> Result<(), HerdrError> {
        cli::notification_show(title, body)
    }

    fn agent_status(&self, pane_id: &str) -> Result<String, HerdrError> {
        cli::agent_status(pane_id)
    }

    fn agent_label(&self, pane_id: &str) -> Result<String, HerdrError> {
        cli::agent_label(pane_id)
    }

    fn wait_output(&self, pane_id: &str, regex: &str, timeout_ms: u64) -> Result<(), HerdrError> {
        cli::wait_output(pane_id, regex, timeout_ms)
    }

    fn pane_read(&self, pane_id: &str, opts: PaneReadOpts) -> Result<String, HerdrError> {
        cli::pane_read(pane_id, opts)
    }

    fn report_token(&self, pane_id: &str, value: Option<&str>) -> Result<(), HerdrError> {
        cli::report_token(pane_id, value)
    }

    fn session_text(&self, pane_id: &str, sessions: &SessionsConfig) -> Result<String, HerdrError> {
        super::session::session_text_default(pane_id, sessions)
    }

    fn tab_close(&self, tab_id: &str) -> Result<(), HerdrError> {
        cli::tab_close(tab_id)
    }
}

/// `StepResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResult {
    pub ok: bool,
    pub error: Option<String>,
    pub last: String,
}

impl StepResult {
    #[must_use]
    pub fn ok(last: String) -> Self {
        Self {
            ok: true,
            error: None,
            last,
        }
    }

    #[must_use]
    pub fn failed(error: String, last: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
            last,
        }
    }
}

/// Progress callback — `onProgress(step, total, label)`.
pub type ProgressCallback<'a> = &'a dyn Fn(usize, usize, &str);

/// Per-step-sequence options — `StepRunOptions`.
pub struct StepRunOptions<'a> {
    pub name: &'a str,
    pub agents: &'a AgentsConfig,
    pub ctx: &'a InvocationContext,
    pub herdr: &'a dyn Herdr,
    pub run_log: &'a RunLog,
    pub run_id: &'a str,
    pub wait_clock: &'a AgentWaitClock,
    pub on_progress: Option<ProgressCallback<'a>>,
    pub on_stderr: Option<&'a dyn Fn(&str)>,
}

/// `inputEnv` — `HWF_INPUT_<name>` overlay for shell steps.
#[must_use]
pub fn input_env(inputs: &BTreeMap<String, String>) -> Vec<(String, String)> {
    inputs
        .iter()
        .map(|(name, value)| (format!("HWF_INPUT_{name}"), value.clone()))
        .collect()
}
