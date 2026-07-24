//! Pre-run precondition resolution. Port of `src/runner/preflight.ts`:
//! `{session}` and `{agent}` requirements; session extraction failure is
//! non-fatal (recovery can fall back to `{pane}`).

use super::deps::Herdr;
use crate::config::{AgentsConfig, SessionsConfig};
use crate::runner::context::InvocationContext;
use crate::workflow::load::LoadedWorkflow;

/// `Preflight`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preflight {
    /// Preconditions satisfied; `session_failure` still runs `on_fail`.
    Ok {
        session: String,
        session_failure: Option<String>,
        agent: String,
    },
    /// Hard failure before any step runs.
    Err(String),
}

/// `resolvePreflight`.
pub fn resolve_preflight(
    workflow: &LoadedWorkflow,
    ctx: &InvocationContext,
    agents: &AgentsConfig,
    sessions: &SessionsConfig,
    herdr: &dyn Herdr,
) -> Preflight {
    let mut session = String::new();
    let mut session_failure: Option<String> = None;
    if workflow.needs_session {
        let Some(pane_id) = ctx.pane_id.as_deref() else {
            return Preflight::Err(
                "session handoff must be launched from an agent pane".to_string(),
            );
        };
        match herdr.session_text(pane_id, sessions) {
            Ok(text) => session = text,
            Err(error) => session_failure = Some(error.message),
        }
    }

    let mut agent = String::new();
    if workflow.needs_invoking_agent {
        let Some(pane_id) = ctx.pane_id.as_deref() else {
            return Preflight::Err("invoking agent unresolved — run from agent pane".to_string());
        };
        match herdr.agent_label(pane_id) {
            Ok(label) => {
                if !agents.contains_key(&label) {
                    return Preflight::Err(format!(
                        "invoking agent '{label}' not in config — add it under agents:"
                    ));
                }
                agent = label;
            }
            Err(error) => return Preflight::Err(error.message),
        }
    }
    Preflight::Ok {
        session,
        session_failure,
        agent,
    }
}
