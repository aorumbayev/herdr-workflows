//! Run-screen progress model and the seam the runner (task 3.4) plugs into.
//! Execution is NOT implemented here: the picker shell (task 3.2) receives a
//! [`RunRequest`] from the state machine, hands it to a [`RunExecutor`] on a
//! worker thread, and feeds the streamed [`RunEvent`]s back into
//! `Picker::apply_run_event` over a `std::sync::mpsc` channel.

use std::collections::BTreeMap;
use std::sync::mpsc::Sender;

use crate::workflow::load::LoadedWorkflow;

/// Everything the runner needs to execute a picker-initiated run. `prompt`
/// and every `inputs` value are already `sanitize_display`-ed.
#[derive(Debug, Clone, PartialEq)]
pub struct RunRequest {
    pub name: String,
    pub prompt: String,
    pub inputs: BTreeMap<String, String>,
    pub workflow: LoadedWorkflow,
}

/// One progress update from the runner to the run screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    /// Step `step` of `total` started; `label` is rendered as
    /// `[step/total] label` (label truncated to 48 chars by the picker).
    Progress { step: usize, total: usize, label: String },
    /// The run terminated. `Ok(())` exits the picker with code 0; `Err`
    /// carries the detail shown as `Failed · <detail>`, after which the next
    /// keypress exits with code 1.
    Finished(Result<(), String>),
}

/// Execution seam implemented by the runner integration (task 3.4). Called
/// on a worker thread; implementations send every progress update through
/// `events` and exactly one terminating [`RunEvent::Finished`].
pub trait RunExecutor {
    /// Execute `request` to completion, streaming progress into `events`.
    fn execute(&self, request: RunRequest, events: Sender<RunEvent>);
}
