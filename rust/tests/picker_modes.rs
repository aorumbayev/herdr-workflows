//! State-machine assertions for the picker modes, porting the picker parts
//! of `test/workflow-review-fixes.test.ts` and pinning the picker-ui spec
//! transitions (gating, input/prompt sequencing, escape-backs-out, exit
//! codes).

use herdr_workflows::picker::modes::{
    Action, CONFIRM_HINT, FAIL_HINT, InputKind, Mode, Picker, Screen,
};
use herdr_workflows::picker::run::RunEvent;
use herdr_workflows::workflow::errors::{InputSpec, Source, WorkflowListEntry};
use herdr_workflows::workflow::load::LoadedWorkflow;

fn entry(name: &str, source: Source, file: &str) -> WorkflowListEntry {
    WorkflowListEntry::new(name.to_string(), source, file.to_string())
}

fn text_input(name: &str) -> InputSpec {
    InputSpec {
        name: name.to_string(),
        label: name.to_string(),
        options: None,
        dynamic_options: false,
        default: None,
    }
}

fn choice_input(name: &str, options: &[&str], default: Option<&str>) -> InputSpec {
    InputSpec {
        name: name.to_string(),
        label: name.to_string(),
        options: Some(options.iter().map(|o| (*o).to_string()).collect()),
        dynamic_options: false,
        default: default.map(str::to_string),
    }
}

fn workflow(name: &str, inputs: Vec<InputSpec>, needs_prompt: bool, repo_owned: bool) -> LoadedWorkflow {
    LoadedWorkflow {
        name: name.to_string(),
        file: format!("/r/{name}.yaml"),
        steps: Vec::new(),
        inputs,
        on_fail: None,
        recovery: None,
        repo_owned,
        needs_prompt,
        needs_session: false,
        needs_invoking_agent: false,
    }
}

fn plain_workflow(name: &str) -> LoadedWorkflow {
    workflow(name, Vec::new(), false, false)
}

fn run_screen(picker: &Picker) -> &herdr_workflows::picker::modes::RunScreen {
    match picker.screen() {
        Screen::Run(run) => run,
        other => panic!("expected run screen, got {other:?}"),
    }
}

#[test]
fn escape_on_list_exits_zero() {
    let mut picker = Picker::new(Vec::new());
    assert_eq!(picker.mode(), Mode::List);
    assert_eq!(picker.escape(), Action::Exit(0));
    assert_eq!(picker.exit_code(), Some(0));
}

#[test]
fn repo_workflow_requires_confirmation() {
    let mut picker = Picker::new(vec![entry("deploy", Source::Repo, "/r/deploy.yaml")]);
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);
    let Screen::Confirm(confirm) = picker.screen() else {
        panic!("expected confirm screen");
    };
    assert_eq!(confirm.message(), "deploy · workflow may run shell commands");
    assert_eq!(picker.screen().hint(), CONFIRM_HINT);

    assert_eq!(picker.accept(), Action::Load { confirmed: true });
    assert_eq!(picker.mode(), Mode::Run);
}

#[test]
fn dynamic_options_require_confirmation() {
    let mut dynamic = entry("dyn", Source::Global, "/g/dyn.yaml");
    dynamic.dynamic_options = Some(true);
    let mut picker = Picker::new(vec![dynamic]);
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);
}

#[test]
fn global_entry_with_repo_owned_composition_requires_confirmation() {
    // Ported from workflow-review-fixes: repo_owned on a global entry gates
    // before any load happens.
    let mut global = entry("global-entry", Source::Global, "/global/entry.yaml");
    global.repo_owned = Some(true);
    let mut picker = Picker::new(vec![global]);
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);
}

#[test]
fn ungated_entry_loads_without_confirmation() {
    let mut picker = Picker::new(vec![entry("deploy", Source::Global, "/g/deploy.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert_eq!(picker.mode(), Mode::Run);
}

#[test]
fn load_revealing_repo_owned_composition_gates_unconfirmed_run() {
    let mut picker = Picker::new(vec![entry("entry", Source::Global, "/g/entry.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    let loaded = workflow("entry", Vec::new(), false, true);
    assert_eq!(picker.loaded(loaded, false), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);

    // Escape back, re-select: the stored entry now knows it is repo-owned
    // (TS mutates the entry in place), so it gates without another load.
    assert_eq!(picker.escape(), Action::None);
    assert_eq!(picker.mode(), Mode::List);
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);
}

#[test]
fn input_screens_follow_declared_inputs_then_prompt() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    let loaded = workflow(
        "flow",
        vec![text_input("region"), text_input("env")],
        true,
        false,
    );
    assert_eq!(picker.loaded(loaded, false), Action::None);

    let Screen::Input(first) = picker.screen() else {
        panic!("expected first input screen");
    };
    assert_eq!(first.spec.name, "region");
    assert_eq!(first.title(), "flow · region");

    picker.set_input_text("  eu  ".to_string());
    assert_eq!(picker.accept(), Action::None);
    let Screen::Input(second) = picker.screen() else {
        panic!("expected second input screen");
    };
    assert_eq!(second.spec.name, "env");

    picker.set_input_text("prod".to_string());
    assert_eq!(picker.accept(), Action::None);
    let Screen::Prompt(prompt) = picker.screen() else {
        panic!("expected prompt screen");
    };
    assert_eq!(prompt.name, "flow");

    picker.set_prompt_text("  ship it  ".to_string());
    let Action::Run(request) = picker.accept() else {
        panic!("expected run action");
    };
    assert_eq!(request.name, "flow");
    assert_eq!(request.prompt, "ship it");
    assert_eq!(request.inputs.get("region").map(String::as_str), Some("eu"));
    assert_eq!(request.inputs.get("env").map(String::as_str), Some("prod"));
    assert_eq!(picker.mode(), Mode::Run);
}

#[test]
fn workflow_without_inputs_or_prompt_runs_immediately() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    let Action::Run(request) = picker.loaded(plain_workflow("flow"), false) else {
        panic!("expected run action");
    };
    assert_eq!(request.name, "flow");
    assert!(request.inputs.is_empty());
    assert_eq!(request.prompt, "");
}

#[test]
fn text_input_seeds_default_and_sanitizes_on_run() {
    let mut input = text_input("target");
    input.default = Some("de\x07fault".to_string());
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert_eq!(picker.loaded(workflow("flow", vec![input], false, false), false), Action::None);

    let Screen::Input(screen) = picker.screen() else {
        panic!("expected input screen");
    };
    let InputKind::Text { value } = &screen.kind else {
        panic!("expected text input");
    };
    assert_eq!(value, "de\x07fault");

    let Action::Run(request) = picker.accept() else {
        panic!("expected run action");
    };
    assert_eq!(request.inputs.get("target").map(String::as_str), Some("default"));
}

#[test]
fn choice_input_preselects_default_and_submits_filtered_selection() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    let loaded = workflow(
        "flow",
        vec![choice_input("branch", &["main", "feat/x", "fix/y"], Some("feat/x"))],
        false,
        false,
    );
    assert_eq!(picker.loaded(loaded, false), Action::None);

    let Screen::Input(screen) = picker.screen() else {
        panic!("expected input screen");
    };
    let InputKind::Choice { selected, .. } = &screen.kind else {
        panic!("expected choice input");
    };
    assert_eq!(*selected, 1);
    assert_eq!(screen.visible_options(), ["main", "feat/x", "fix/y"]);

    picker.set_choice_filter("fix".to_string());
    let Screen::Input(screen) = picker.screen() else {
        panic!("expected input screen");
    };
    assert_eq!(screen.visible_options(), ["fix/y"]);
    let Action::Run(request) = picker.accept() else {
        panic!("expected run action");
    };
    assert_eq!(request.inputs.get("branch").map(String::as_str), Some("fix/y"));
}

#[test]
fn escape_backs_out_of_input_mode_without_running() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert_eq!(
        picker.loaded(workflow("flow", vec![text_input("region")], false, false), false),
        Action::None
    );
    assert_eq!(picker.mode(), Mode::Input);
    assert_eq!(picker.escape(), Action::None);
    assert_eq!(picker.mode(), Mode::List);
    assert!(picker.pending().is_none());
}

#[test]
fn escape_backs_out_of_prompt_and_confirm() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert_eq!(picker.loaded(workflow("flow", Vec::new(), true, false), false), Action::None);
    assert_eq!(picker.mode(), Mode::Prompt);
    assert_eq!(picker.escape(), Action::None);
    assert_eq!(picker.mode(), Mode::List);

    let mut gated = Picker::new(vec![entry("deploy", Source::Repo, "/r/deploy.yaml")]);
    assert_eq!(gated.accept(), Action::None);
    assert_eq!(gated.mode(), Mode::Confirm);
    assert_eq!(gated.escape(), Action::None);
    assert_eq!(gated.mode(), Mode::List);
}

#[test]
fn list_selection_survives_escape_back() {
    let mut picker = Picker::new(vec![
        entry("alpha", Source::Global, "/g/alpha.yaml"),
        entry("beta", Source::Repo, "/r/beta.yaml"),
    ]);
    picker.move_down();
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.mode(), Mode::Confirm);
    assert_eq!(picker.escape(), Action::None);
    let Screen::List(list) = picker.screen() else {
        panic!("expected list screen");
    };
    assert_eq!(list.selected, 1);
}

#[test]
fn selection_wraps_and_filter_clamps() {
    let mut picker = Picker::new(vec![
        entry("alpha", Source::Global, "/g/alpha.yaml"),
        entry("beta", Source::Global, "/g/beta.yaml"),
        entry("gamma", Source::Global, "/g/gamma.yaml"),
    ]);
    picker.move_up();
    let Screen::List(list) = picker.screen() else {
        panic!("expected list screen");
    };
    assert_eq!(list.selected, 2);
    picker.move_down();
    let Screen::List(list) = picker.screen() else {
        panic!("expected list screen");
    };
    assert_eq!(list.selected, 0);

    picker.move_down();
    picker.move_down();
    picker.set_list_filter("alpha".to_string());
    let Screen::List(list) = picker.screen() else {
        panic!("expected list screen");
    };
    assert_eq!(list.selected, 0);
    assert_eq!(list.valid.len(), 1);
}

#[test]
fn invalid_entries_are_dimmed_rows_never_selectable() {
    let mut broken = entry("broken", Source::Repo, "/r/broken.yaml");
    broken.error = Some("/r/broken.yaml, step 2, agent: unknown agent 'x'".to_string());
    let picker = Picker::new(vec![broken]);
    let Screen::List(list) = picker.screen() else {
        panic!("expected list screen");
    };
    assert!(list.rows().is_empty());
    assert_eq!(
        list.invalid_lines(),
        "broken — invalid: step 2, agent: unknown agent 'x'"
    );
}

#[test]
fn loader_error_renders_as_terminal_failure_and_exits_one() {
    // Ported from workflow-review-fixes: "picker renders loader errors as
    // terminal failures".
    let mut picker = Picker::new(vec![entry("broken", Source::Global, "/global/broken.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert_eq!(picker.load_failed("reload failed"), Action::None);

    let run = run_screen(&picker);
    assert!(!run.is_running());
    assert!(run.text().contains("Failed · reload failed"));
    assert_eq!(picker.screen().hint(), FAIL_HINT);

    assert_eq!(picker.accept(), Action::Exit(1));
    assert_eq!(picker.exit_code(), Some(1));
}

#[test]
fn run_failure_shows_error_and_exits_one_on_keypress() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert!(matches!(
        picker.loaded(plain_workflow("flow"), false),
        Action::Run(_)
    ));

    // Keys are ignored while the run is in flight.
    assert_eq!(picker.escape(), Action::None);
    assert_eq!(picker.accept(), Action::None);
    assert_eq!(picker.exit_code(), None);

    assert_eq!(
        picker.apply_run_event(&RunEvent::Progress {
            step: 1,
            total: 1,
            label: "shell".to_string(),
        }),
        Action::None
    );
    assert_eq!(
        picker.apply_run_event(&RunEvent::Finished(Err("boom".to_string()))),
        Action::None
    );
    let run = run_screen(&picker);
    assert_eq!(run.text(), "flow\n[1/1] shell\n\nFailed · boom");
    assert_eq!(picker.escape(), Action::Exit(1));
}

#[test]
fn run_success_exits_zero() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert!(matches!(
        picker.loaded(plain_workflow("flow"), false),
        Action::Run(_)
    ));
    assert_eq!(
        picker.apply_run_event(&RunEvent::Finished(Ok(()))),
        Action::Exit(0)
    );
    assert_eq!(picker.exit_code(), Some(0));
}

#[test]
fn progress_labels_truncate_to_48_chars() {
    let mut picker = Picker::new(vec![entry("flow", Source::Global, "/g/flow.yaml")]);
    assert_eq!(picker.accept(), Action::Load { confirmed: false });
    assert!(matches!(
        picker.loaded(plain_workflow("flow"), false),
        Action::Run(_)
    ));
    let long_label = "x".repeat(100);
    assert_eq!(
        picker.apply_run_event(&RunEvent::Progress {
            step: 2,
            total: 5,
            label: long_label,
        }),
        Action::None
    );
    let run = run_screen(&picker);
    assert_eq!(run.lines, [format!("[2/5] {}…", "x".repeat(47))]);
}
