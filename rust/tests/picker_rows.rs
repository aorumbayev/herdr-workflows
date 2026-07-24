//! Ported row/filter/format assertions from `test/picker.test.ts`, plus the
//! case-insensitivity the picker-ui spec requires (TS `.includes` was
//! case-sensitive — intentional deviation).

use herdr_workflows::picker::rows::{
    RunTerminal, build_picker_rows, filter_choice_options, filter_workflow_entries,
    format_invalid_lines, format_run_progress,
};
use herdr_workflows::workflow::errors::{InputSpec, Source, WorkflowListEntry};

fn entry(name: &str, source: Source, file: &str) -> WorkflowListEntry {
    WorkflowListEntry::new(name.to_string(), source, file.to_string())
}

fn entries() -> Vec<WorkflowListEntry> {
    let mut chat_handoff = entry("chat-handoff", Source::Repo, "/r/chat.yaml");
    chat_handoff.needs_prompt = Some(true);
    let mut broken = entry("broken", Source::Repo, "/r/broken.yaml");
    broken.error = Some("/r/broken.yaml, step 2, agent: unknown agent 'x'".to_string());
    let mut chat_broken = entry("chat-broken", Source::Global, "/g/chat-broken.yaml");
    chat_broken.error = Some("cycle".to_string());
    vec![
        chat_handoff,
        entry("deploy", Source::Global, "/g/deploy.yaml"),
        broken,
        chat_broken,
    ]
}

fn names<'a>(entries: &[&'a WorkflowListEntry]) -> Vec<&'a str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

#[test]
fn filter_splits_valid_and_invalid() {
    let entries = entries();
    let filtered = filter_workflow_entries(&entries, "");
    assert_eq!(names(&filtered.valid), ["chat-handoff", "deploy"]);
    assert_eq!(names(&filtered.invalid), ["broken", "chat-broken"]);
}

#[test]
fn filter_substring_applies_to_both_groups() {
    let entries = entries();
    let filtered = filter_workflow_entries(&entries, "chat");
    assert_eq!(names(&filtered.valid), ["chat-handoff"]);
    assert_eq!(names(&filtered.invalid), ["chat-broken"]);
}

#[test]
fn filter_without_match_yields_empty_lists() {
    let entries = entries();
    let filtered = filter_workflow_entries(&entries, "zzz");
    assert!(filtered.valid.is_empty());
    assert!(filtered.invalid.is_empty());
}

#[test]
fn filter_is_case_insensitive() {
    let entries = entries();
    let filtered = filter_workflow_entries(&entries, "CHAT");
    assert_eq!(names(&filtered.valid), ["chat-handoff"]);
    assert_eq!(names(&filtered.invalid), ["chat-broken"]);
}

#[test]
fn row_label_flags_inputs() {
    let mut handover = entry("handover", Source::Repo, "/r/handover.yaml");
    handover.inputs = Some(vec![InputSpec {
        name: "target".to_string(),
        label: "target".to_string(),
        options: Some(vec!["claude".to_string()]),
        dynamic_options: false,
        default: None,
    }]);
    let rows = build_picker_rows([&handover]);
    assert_eq!(rows[0].label, "handover · repo · inputs");
}

#[test]
fn row_labels_show_source_and_prompt_marker() {
    let entries = entries();
    let filtered = filter_workflow_entries(&entries, "");
    let rows = build_picker_rows(filtered.valid);
    let labels: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
    assert_eq!(labels, ["chat-handoff · repo · prompt", "deploy · global"]);
    assert!(std::ptr::eq(rows[0].entry, &entries[0]));
}

#[test]
fn invalid_lines_truncate_error_and_empty_when_none() {
    assert_eq!(format_invalid_lines(Vec::<&WorkflowListEntry>::new()), "");
    let entries = entries();
    let lines = format_invalid_lines([&entries[2]]);
    assert_eq!(lines, "broken — invalid: step 2, agent: unknown agent 'x'");
}

#[test]
fn invalid_lines_truncate_to_44_chars() {
    let mut entry = entry("long", Source::Repo, "/r/long.yaml");
    entry.error = Some("/r/long.yaml: ".to_string() + &"x".repeat(100));
    let lines = format_invalid_lines([&entry]);
    let expected = format!("long — invalid: {}…", "x".repeat(43));
    assert_eq!(lines, expected);
}

#[test]
fn run_progress_formats_pending_and_terminal_states() {
    assert_eq!(format_run_progress("handoff", &[], None), "handoff\n…");
    assert_eq!(
        format_run_progress("handoff", &["[1/2] shell".to_string()], None),
        "handoff\n[1/2] shell"
    );
    assert_eq!(
        format_run_progress(
            "handoff",
            &["[1/1] shell".to_string()],
            Some(RunTerminal {
                ok: true,
                detail: String::new(),
            }),
        ),
        "handoff\n[1/1] shell\n\nDone."
    );
    assert_eq!(
        format_run_progress(
            "handoff",
            &["[1/1] shell".to_string()],
            Some(RunTerminal {
                ok: false,
                detail: "boom".to_string(),
            }),
        ),
        "handoff\n[1/1] shell\n\nFailed · boom"
    );
}

#[test]
fn choice_filter_substring_and_empty_keeps_all() {
    let options = vec![
        "main".to_string(),
        "feat/workflow-inputs".to_string(),
        "fix/token".to_string(),
    ];
    assert_eq!(
        filter_choice_options(&options, ""),
        ["main", "feat/workflow-inputs", "fix/token"]
    );
    assert_eq!(filter_choice_options(&options, "feat"), ["feat/workflow-inputs"]);
    assert_eq!(filter_choice_options(&options, "FEAT"), ["feat/workflow-inputs"]);
    assert!(filter_choice_options(&options, "zzz").is_empty());
}
