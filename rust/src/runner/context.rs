//! Invocation context from herdr env. Port of `src/context.ts` plus the
//! `sanitizeDisplay` half of `src/adapter/stdin.ts` and the `src/pane-read.ts`
//! constants (the prompt-input half of `stdin.ts` belongs to the picker).

use serde::Deserialize;

/// `PANE_READ_LINES` — request ceiling for pane scrollback.
pub const PANE_READ_LINES: u32 = 100_000;
/// `PANE_READ_SOURCE`.
pub const PANE_READ_SOURCE: &str = "recent-unwrapped";

/// `InvocationContext` — who/where the plugin was invoked from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InvocationContext {
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub selection: String,
    pub cwd: String,
}

/// `CtxJson` — the `HERDR_PLUGIN_CONTEXT_JSON` payload shape.
#[derive(Debug, Default, Deserialize)]
struct CtxJson {
    workspace_id: Option<String>,
    tab_id: Option<String>,
    focused_pane_id: Option<String>,
    focused_pane_cwd: Option<String>,
    pane_id: Option<String>,
    selected_text: Option<String>,
    cwd: Option<String>,
    worktree: Option<CtxWorktree>,
    workspace: Option<CtxWorkspace>,
    tab: Option<CtxTab>,
    pane: Option<CtxPane>,
}

#[derive(Debug, Deserialize)]
struct CtxWorktree {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CtxWorkspace {
    workspace_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CtxTab {
    tab_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CtxPane {
    pane_id: Option<String>,
}

/// Core of `readInvocationContext`, with env access injected so tests stay
/// parallel-safe. Precedence matches TS: env var, then flat JSON key, then
/// nested object; cwd falls back through worktree → pane cwd → json cwd →
/// workspace cwd → process cwd. Invalid JSON degrades to empty.
fn invocation_context_from(
    raw_json: Option<&str>,
    var: impl Fn(&str) -> Option<String>,
    cwd_fallback: String,
) -> InvocationContext {
    let json: CtxJson = raw_json
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let (nested_workspace, nested_tab, nested_pane) = (
        json.workspace.as_ref().and_then(|w| w.workspace_id.clone()),
        json.tab.as_ref().and_then(|t| t.tab_id.clone()),
        json.pane.as_ref().and_then(|p| p.pane_id.clone()),
    );
    let workspace_cwd = json.workspace.as_ref().and_then(|w| w.cwd.clone());
    // `||` chains in TS skip empty strings, so filter them at every step.
    let or_empty = |value: Option<String>| value.filter(|v| !v.is_empty());
    InvocationContext {
        workspace_id: or_empty(var("HERDR_WORKSPACE_ID"))
            .or(json.workspace_id)
            .or(nested_workspace),
        tab_id: or_empty(var("HERDR_TAB_ID")).or(json.tab_id).or(nested_tab),
        pane_id: or_empty(var("HERDR_PANE_ID"))
            .or(json.focused_pane_id)
            .or(json.pane_id)
            .or(nested_pane),
        selection: json.selected_text.unwrap_or_default(),
        cwd: or_empty(json.worktree.and_then(|w| w.path))
            .or_else(|| or_empty(json.focused_pane_cwd))
            .or_else(|| or_empty(json.cwd))
            .or_else(|| or_empty(workspace_cwd))
            .unwrap_or(cwd_fallback),
    }
}

/// `readInvocationContext` — env + `HERDR_PLUGIN_CONTEXT_JSON`, cwd fallback
/// is the process cwd.
#[must_use]
pub fn read_invocation_context() -> InvocationContext {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    invocation_context_from(
        std::env::var("HERDR_PLUGIN_CONTEXT_JSON").ok().as_deref(),
        |name| std::env::var(name).ok(),
        cwd,
    )
}

/// `sanitizeDisplay` — strip C0 controls from AI/evidence text before it
/// reaches the terminal (tab/CR/LF kept).
#[must_use]
pub fn sanitize_display(raw: &str) -> String {
    raw.chars()
        .filter(|&c| matches!(c, '\t' | '\n' | '\r') || c >= ' ')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn empty_env_yields_cwd_fallback_and_empty_selection() {
        let ctx = invocation_context_from(None, no_env, "/fallback".to_string());
        assert_eq!(
            ctx,
            InvocationContext {
                cwd: "/fallback".to_string(),
                ..InvocationContext::default()
            }
        );
    }

    #[test]
    fn invalid_json_degrades_to_empty() {
        let ctx = invocation_context_from(Some("{nope"), no_env, "/fb".to_string());
        assert_eq!(ctx.cwd, "/fb");
        assert_eq!(ctx.pane_id, None);
    }

    #[test]
    fn env_vars_beat_json_keys() {
        let ctx = invocation_context_from(
            Some(r#"{"workspace_id":"jw","tab_id":"jt","focused_pane_id":"jp"}"#),
            |name| match name {
                "HERDR_WORKSPACE_ID" => Some("ew".to_string()),
                "HERDR_TAB_ID" => Some("et".to_string()),
                "HERDR_PANE_ID" => Some("ep".to_string()),
                _ => None,
            },
            "/fb".to_string(),
        );
        assert_eq!(ctx.workspace_id.as_deref(), Some("ew"));
        assert_eq!(ctx.tab_id.as_deref(), Some("et"));
        assert_eq!(ctx.pane_id.as_deref(), Some("ep"));
    }

    #[test]
    fn nested_json_objects_fill_missing_flat_keys() {
        let ctx = invocation_context_from(
            Some(
                r#"{
                "workspace": {"workspace_id": "w1", "cwd": "/ws"},
                "tab": {"tab_id": "t1"},
                "pane": {"pane_id": "p1"},
                "selected_text": "sel"
            }"#,
            ),
            no_env,
            "/fb".to_string(),
        );
        assert_eq!(ctx.workspace_id.as_deref(), Some("w1"));
        assert_eq!(ctx.tab_id.as_deref(), Some("t1"));
        assert_eq!(ctx.pane_id.as_deref(), Some("p1"));
        assert_eq!(ctx.selection, "sel");
        assert_eq!(ctx.cwd, "/ws");
    }

    #[test]
    fn cwd_prefers_worktree_then_pane_cwd_then_flat_cwd() {
        let with = |raw: &str| invocation_context_from(Some(raw), no_env, "/fb".to_string()).cwd;
        assert_eq!(
            with(r#"{"worktree":{"path":"/wt"},"focused_pane_cwd":"/pc","cwd":"/c"}"#),
            "/wt"
        );
        assert_eq!(with(r#"{"focused_pane_cwd":"/pc","cwd":"/c"}"#), "/pc");
        assert_eq!(with(r#"{"cwd":"/c"}"#), "/c");
    }

    #[test]
    fn sanitize_display_strips_c0_keeps_tab_cr_lf() {
        assert_eq!(
            sanitize_display("a\u{0}\u{7}\u{1b}\tb\rc\nd\u{1f}e"),
            "a\tb\rc\nde"
        );
        assert_eq!(sanitize_display("unicode ✓ ok"), "unicode ✓ ok");
    }
}
