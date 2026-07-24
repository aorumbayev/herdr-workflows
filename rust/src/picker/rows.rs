//! Row building and formatting for the picker list. Port of
//! `src/tui/picker-rows.ts`. Filters are case-insensitive per the picker-ui
//! spec (the TS `.includes` was case-sensitive — intentional deviation,
//! applied to both workflow and choice filters).

use crate::workflow::errors::{Source, WorkflowListEntry};

use super::text::{strip_file_prefix, truncate};

/// Max width of the truncated load error on a dimmed invalid row.
const INVALID_ERROR_MAX: usize = 44;

/// One selectable list row — display label plus the entry it selects.
#[derive(Debug, Clone, PartialEq)]
pub struct PickerRow<'a> {
    pub label: String,
    pub entry: &'a WorkflowListEntry,
}

/// `filterWorkflowEntries`: entries matching `filter` (case-insensitive
/// substring on the name), split into runnable (`valid`) and dimmed
/// (`invalid`, load `error` set) groups. Both preserve discovery order.
#[must_use]
pub fn filter_workflow_entries<'a>(
    entries: &'a [WorkflowListEntry],
    filter: &str,
) -> FilteredEntries<'a> {
    let needle = filter.to_lowercase();
    let mut filtered = FilteredEntries::default();
    for entry in entries {
        if !needle.is_empty() && !entry.name.to_lowercase().contains(&needle) {
            continue;
        }
        if entry.error.is_some() {
            filtered.invalid.push(entry);
        } else {
            filtered.valid.push(entry);
        }
    }
    filtered
}

/// Result of [`filter_workflow_entries`].
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FilteredEntries<'a> {
    pub valid: Vec<&'a WorkflowListEntry>,
    pub invalid: Vec<&'a WorkflowListEntry>,
}

/// `buildPickerOptions`: `name · source` plus `· inputs` / `· prompt`
/// markers. Invalid entries never reach this — they are not selectable.
#[must_use]
pub fn build_picker_rows<'a, I>(valid: I) -> Vec<PickerRow<'a>>
where
    I: IntoIterator<Item = &'a WorkflowListEntry>,
{
    valid
        .into_iter()
        .map(|entry| {
            let mut label = format!("{} · {}", entry.name, source_label(entry.source));
            if entry.inputs.as_ref().is_some_and(|inputs| !inputs.is_empty()) {
                label.push_str(" · inputs");
            }
            if entry.needs_prompt == Some(true) {
                label.push_str(" · prompt");
            }
            PickerRow { label, entry }
        })
        .collect()
}

/// `formatInvalidLines`: one dimmed line per invalid entry —
/// `name — invalid: <error>` with the file label stripped and the error
/// truncated to 44 chars. Empty input yields an empty string (block hidden).
#[must_use]
pub fn format_invalid_lines<'a, I>(invalid: I) -> String
where
    I: IntoIterator<Item = &'a WorkflowListEntry>,
{
    invalid
        .into_iter()
        .map(|entry| {
            let detail = strip_file_prefix(entry.error.as_deref().unwrap_or_default(), &entry.file);
            format!(
                "{} — invalid: {}",
                entry.name,
                truncate(detail, INVALID_ERROR_MAX)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Terminal state appended to the run screen body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTerminal {
    pub ok: bool,
    pub detail: String,
}

/// `formatRunProgress`: `name` over the progress lines (`…` while none), with
/// `Done.` / `Failed · <detail>` appended once the run terminates.
#[must_use]
pub fn format_run_progress(name: &str, lines: &[String], terminal: Option<RunTerminal>) -> String {
    let body = if lines.is_empty() {
        "…".to_string()
    } else {
        lines.join("\n")
    };
    match terminal {
        None => format!("{name}\n{body}"),
        Some(terminal) if terminal.ok => format!("{name}\n{body}\n\nDone."),
        Some(terminal) => format!("{name}\n{body}\n\nFailed · {}", terminal.detail),
    }
}

/// `filterChoiceOptions`: case-insensitive substring filter over choice
/// options; an empty filter keeps all options in order.
#[must_use]
pub fn filter_choice_options<'a>(options: &'a [String], filter: &str) -> Vec<&'a str> {
    if filter.is_empty() {
        return options.iter().map(String::as_str).collect();
    }
    let needle = filter.to_lowercase();
    options
        .iter()
        .filter(|option| option.to_lowercase().contains(&needle))
        .map(String::as_str)
        .collect()
}

fn source_label(source: Source) -> &'static str {
    match source {
        Source::Repo => "repo",
        Source::Global => "global",
    }
}
