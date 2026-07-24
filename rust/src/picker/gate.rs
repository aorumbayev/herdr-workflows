//! Confirm-gate predicate. Port of the `acceptWorkflow` guard in
//! `src/tui/picker-run.ts`: repo-owned or dynamic-options workflows may run
//! shell commands from the repository, so they require an explicit confirm
//! screen before any input collection or execution.

use crate::workflow::errors::{Source, WorkflowListEntry};

/// Whether selecting `entry` must land on the confirm screen. `repo_owned`
/// is authoritative once listing loaded the workflow (it accounts for repo
/// workflows spliced into a global one via `run:`); before that, the
/// discovery `source` decides. `dynamic_options` gates because the choices
/// command executes on confirm.
#[must_use]
pub fn requires_confirm(entry: &WorkflowListEntry) -> bool {
    entry.repo_owned.unwrap_or(matches!(entry.source, Source::Repo))
        || entry.dynamic_options.unwrap_or(false)
}
