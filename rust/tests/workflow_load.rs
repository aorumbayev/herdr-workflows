//! Ported composition/inputs/recovery/discovery assertions from
//! `test/workflows.test.ts` and the loader-level ones from
//! `test/workflow-review-fixes.test.ts`. Parse-only assertions live in
//! `workflow_parse.rs`; substitution assertions land with task 1.6.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use herdr_workflows::workflow::discover::{WorkflowDirs, collect_workflow_entries};
use herdr_workflows::workflow::errors::{InputSpec, Source, WorkflowListEntry};
use herdr_workflows::workflow::load::{list_workflows, load_workflow, load_workflow_entry};
use herdr_workflows::workflow::steps::FlatStep;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("hwf-load-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A temp repo with the given workflows plus an isolated (empty) global dir.
fn repo_with(files: &[(&str, &str)]) -> (TempDir, TempDir, WorkflowDirs) {
    let root = TempDir::new("repo");
    let global = TempDir::new("global");
    let workflows = root.path().join(".hwf").join("workflows");
    std::fs::create_dir_all(&workflows).expect("create workflows dir");
    for (name, body) in files {
        std::fs::write(workflows.join(format!("{name}.yaml")), body).expect("write workflow");
    }
    let dirs = WorkflowDirs {
        repo_root: root.path().to_path_buf(),
        global: global.path().to_path_buf(),
    };
    (root, global, dirs)
}

fn agents(names: &[&str]) -> HashSet<String> {
    names.iter().map(|s| (*s).to_string()).collect()
}

fn no_agents() -> HashSet<String> {
    HashSet::new()
}

fn load_err(dirs: &WorkflowDirs, name: &str, agents: &HashSet<String>) -> String {
    match load_workflow(name, dirs, agents) {
        Ok(_) => panic!("expected load error for '{name}'"),
        Err(e) => e.to_string(),
    }
}

fn shell(command: &str) -> FlatStep {
    FlatStep::Shell {
        command: command.to_string(),
        stdin: None,
    }
}

// --- "composition" describe ---

#[test]
fn run_splices_steps_in_place() {
    let (_root, _global, dirs) = repo_with(&[
        ("gate", "steps:\n  - shell: test\n"),
        (
            "ship",
            "steps:\n  - shell: lint\n  - run: gate\n  - open: lazygit\n",
        ),
    ]);
    let workflow = load_workflow("ship", &dirs, &no_agents()).expect("load ship");
    assert_eq!(
        workflow.steps,
        vec![
            shell("lint"),
            shell("test"),
            FlatStep::Open {
                command: "lazygit".to_string(),
                wait_for: None,
                timeout_ms: None,
            },
        ]
    );
}

#[test]
fn unknown_run_target_rejected() {
    let (_root, _global, dirs) = repo_with(&[("bad", "steps:\n  - run: nonexistent\n")]);
    let err = load_err(&dirs, "bad", &no_agents());
    assert!(err.contains("nonexistent"), "{err}");
}

#[test]
fn cycle_rejected() {
    let (_root, _global, dirs) =
        repo_with(&[("a", "steps:\n  - run: b\n"), ("b", "steps:\n  - run: a\n")]);
    let err = load_err(&dirs, "a", &no_agents());
    assert!(err.contains("cycle"), "{err}");
}

#[test]
fn self_reference_rejected() {
    let (_root, _global, dirs) = repo_with(&[("a", "steps:\n  - run: a\n")]);
    let err = load_err(&dirs, "a", &no_agents());
    assert!(err.contains("cycle"), "{err}");
}

#[test]
fn on_fail_on_run_target_rejected() {
    let (_root, _global, dirs) = repo_with(&[
        ("gate", "steps:\n  - shell: \"true\"\non_fail: handoff\n"),
        ("handoff", "steps:\n  - shell: \"true\"\n"),
        ("ship", "steps:\n  - run: gate\n"),
    ]);
    let err = load_err(&dirs, "ship", &no_agents());
    assert!(err.contains("on_fail"), "{err}");
}

#[test]
fn on_fail_on_recovery_target_rejected() {
    let (_root, _global, dirs) = repo_with(&[
        ("nested", "steps:\n  - shell: \"true\"\non_fail: x\n"),
        ("x", "steps:\n  - shell: \"true\"\n"),
        ("ship", "steps:\n  - shell: \"true\"\non_fail: nested\n"),
    ]);
    let err = load_err(&dirs, "ship", &no_agents());
    assert!(err.contains("on_fail"), "{err}");
}

#[test]
fn needs_prompt_true_when_recovery_references_prompt() {
    let (_root, _global, dirs) = repo_with(&[
        (
            "handoff",
            "steps:\n  - agent: claude\n    prompt: \"{prompt}\"\n",
        ),
        ("ship", "steps:\n  - shell: \"true\"\non_fail: handoff\n"),
    ]);
    let workflow = load_workflow("ship", &dirs, &agents(&["claude"])).expect("load ship");
    assert!(workflow.needs_prompt);
    assert_eq!(workflow.on_fail.as_deref(), Some("handoff"));
    let recovery = workflow.recovery.expect("recovery steps");
    assert_eq!(recovery.name, "handoff");
}

// --- "inputs" describe ---

#[test]
fn input_refs_and_prompt_in_params_arrays_are_discovered() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target: {}\nsteps:\n  - herdr: pane.send\n    params:\n      items: [\"{input.target}\", { prompt: \"{prompt}\" }]\n",
    )]);
    let workflow = load_workflow("wf", &dirs, &no_agents()).expect("load wf");
    let names: Vec<&str> = workflow.inputs.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["target"]);
    assert!(workflow.needs_prompt);
}

#[test]
fn choice_and_text_inputs_resolve_agents_sentinel_expands() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target:\n    options: agents\n  focus:\n    label: focus area\n    default: \"\"\nsteps:\n  - agent: \"{input.target}\"\n    prompt: \"{input.focus}\"\n",
    )]);
    let workflow = load_workflow("wf", &dirs, &agents(&["claude", "codex"])).expect("load wf");
    assert_eq!(
        workflow.inputs,
        vec![
            InputSpec {
                name: "target".to_string(),
                label: "target".to_string(),
                options: Some(vec!["claude".to_string(), "codex".to_string()]),
                dynamic_options: false,
                default: None,
            },
            InputSpec {
                name: "focus".to_string(),
                label: "focus area".to_string(),
                options: None,
                dynamic_options: false,
                default: Some(String::new()),
            },
        ]
    );
}

#[test]
fn input_declaration_order_is_preserved() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  zebra: {}\n  alpha: {}\nsteps:\n  - shell: cat\n    stdin: \"{input.zebra}{input.alpha}\"\n",
    )]);
    let workflow = load_workflow("wf", &dirs, &no_agents()).expect("load wf");
    let names: Vec<&str> = workflow.inputs.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["zebra", "alpha"], "declaration order, not sorted");
}

#[test]
fn undeclared_input_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "steps:\n  - shell: cat\n    stdin: \"{input.nope}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("undeclared input"), "{err}");
}

#[test]
fn declared_but_unused_input_rejected() {
    let (_root, _global, dirs) =
        repo_with(&[("wf", "inputs:\n  ghost: {}\nsteps:\n  - shell: \"true\"\n")]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("never referenced"), "{err}");
}

#[test]
fn agent_input_option_outside_config_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target:\n    options: [claude, ghost]\nsteps:\n  - agent: \"{input.target}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &agents(&["claude"]));
    assert!(err.contains("not a config agent"), "{err}");
}

#[test]
fn text_input_as_agent_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target: {}\nsteps:\n  - agent: \"{input.target}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &agents(&["claude"]));
    assert!(err.contains("needs options"), "{err}");
}

#[test]
fn spliced_workflow_with_inputs_rejected() {
    let (_root, _global, dirs) = repo_with(&[
        (
            "part",
            "inputs:\n  x: {}\nsteps:\n  - shell: cat\n    stdin: \"{input.x}\"\n",
        ),
        ("wf", "steps:\n  - run: part\n"),
    ]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("declares inputs"), "{err}");
}

#[test]
fn options_agents_with_no_configured_agents_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target:\n    options: agents\nsteps:\n  - agent: \"{input.target}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("no agents configured"), "{err}");
}

#[test]
fn choice_default_outside_options_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  target:\n    options: [a, b]\n    default: c\nsteps:\n  - shell: cat\n    stdin: \"{input.target}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("not in options"), "{err}");
}

#[test]
fn recovery_may_reference_entry_inputs() {
    let (_root, _global, dirs) = repo_with(&[
        (
            "rescue",
            "steps:\n  - shell: cat\n    stdin: \"{input.focus}\"\n",
        ),
        (
            "wf",
            "inputs:\n  focus: {}\non_fail: rescue\nsteps:\n  - shell: cat\n    stdin: \"{input.focus}\"\n",
        ),
    ]);
    let workflow = load_workflow("wf", &dirs, &no_agents()).expect("load wf");
    let names: Vec<&str> = workflow.inputs.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["focus"]);
}

#[test]
fn options_shell_command_expands_stdout_lines() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  branch:\n    options: \"printf 'main\\nfeat/x\\n'\"\nsteps:\n  - shell: cat\n    stdin: \"{input.branch}\"\n",
    )]);
    let workflow = load_workflow("wf", &dirs, &no_agents()).expect("load wf");
    assert_eq!(
        workflow.inputs[0],
        InputSpec {
            name: "branch".to_string(),
            label: "branch".to_string(),
            options: Some(vec!["main".to_string(), "feat/x".to_string()]),
            dynamic_options: false,
            default: None,
        }
    );
}

#[test]
fn options_shell_command_failure_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  branch:\n    options: \"exit 1\"\nsteps:\n  - shell: cat\n    stdin: \"{input.branch}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("options command failed"), "{err}");
}

#[test]
fn options_shell_command_empty_stdout_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  branch:\n    options: \"true\"\nsteps:\n  - shell: cat\n    stdin: \"{input.branch}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("no choices"), "{err}");
}

#[test]
fn options_shell_command_timeout_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  branch:\n    options: \"sleep 30\"\nsteps:\n  - shell: cat\n    stdin: \"{input.branch}\"\n",
    )]);
    let started = std::time::Instant::now();
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("options command timed out after 5s"), "{err}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "timeout must kill the command, not wait for it"
    );
}

#[test]
fn dynamic_options_default_outside_resolved_set_rejected() {
    let (_root, _global, dirs) = repo_with(&[(
        "wf",
        "inputs:\n  branch:\n    options: \"printf 'main\\n'\"\n    default: other\nsteps:\n  - shell: cat\n    stdin: \"{input.branch}\"\n",
    )]);
    let err = load_err(&dirs, "wf", &no_agents());
    assert!(err.contains("not in options"), "{err}");
}

// --- discovery ---

#[test]
fn repo_shadows_global_and_entries_are_sorted() {
    let (_root, global, dirs) = repo_with(&[
        ("shared", "steps:\n  - shell: repo\n"),
        ("repo-only", "steps:\n  - shell: \"true\"\n"),
    ]);
    std::fs::write(
        global.path().join("shared.yaml"),
        "steps:\n  - shell: global\n",
    )
    .expect("write global shared");
    std::fs::write(
        global.path().join("global-only.yaml"),
        "steps:\n  - shell: \"true\"\n",
    )
    .expect("write global-only");

    let entries = collect_workflow_entries(&dirs);
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["global-only", "repo-only", "shared"]);
    let shared = entries
        .iter()
        .find(|e| e.name == "shared")
        .expect("shared entry");
    assert_eq!(shared.source, Source::Repo);
    assert!(
        shared.file.ends_with(".hwf/workflows/shared.yaml"),
        "repo path must win, got {}",
        shared.file
    );
    let global_only = entries
        .iter()
        .find(|e| e.name == "global-only")
        .expect("global-only entry");
    assert_eq!(global_only.source, Source::Global);
}

#[test]
fn load_workflow_unknown_name_is_plain_error() {
    let (_root, _global, dirs) = repo_with(&[]);
    let err = load_err(&dirs, "ghost", &no_agents());
    assert_eq!(err, "workflow 'ghost' not found");
}

// --- loader-level assertions from test/workflow-review-fixes.test.ts ---

#[test]
fn listing_dynamic_options_does_not_execute_their_command() {
    let (root, _global, dirs) = repo_with(&[(
        "dynamic",
        "inputs:\n  target:\n    options: \"touch option-command-ran; printf main\"\nsteps:\n  - shell: cat\n    stdin: \"{input.target}\"\n",
    )]);
    let marker = root.path().join("option-command-ran");

    let entries = list_workflows(&dirs, &no_agents());
    assert!(!marker.exists(), "listing must not run options commands");
    let entry = entries
        .iter()
        .find(|e| e.name == "dynamic")
        .expect("dynamic entry");
    assert_eq!(entry.error, None);
    assert_eq!(entry.dynamic_options, Some(true));

    let workflow = load_workflow("dynamic", &dirs, &no_agents()).expect("load dynamic");
    assert_eq!(workflow.inputs[0].options, Some(vec!["main".to_string()]));
    assert!(marker.exists(), "full load must run options commands");
}

#[test]
fn listing_validates_dynamic_workflows_without_executing_choices() {
    let (root, _global, dirs) = repo_with(&[(
        "invalid",
        "inputs:\n  unused:\n    options: \"touch invalid-option-ran; printf value\"\nsteps:\n  - shell: \"true\"\n",
    )]);
    let entries = list_workflows(&dirs, &no_agents());
    let entry = entries
        .iter()
        .find(|e| e.name == "invalid")
        .expect("invalid entry");
    let error = entry
        .error
        .as_ref()
        .expect("entry must carry its load error");
    assert!(error.contains("declared but never referenced"), "{error}");
    assert!(
        !root.path().join("invalid-option-ran").exists(),
        "listing must not run options commands"
    );
}

#[test]
fn exact_global_entry_cannot_be_replaced_by_repo_shadow_during_load() {
    let (root, _global, dirs) = repo_with(&[(
        "entry",
        "inputs:\n  target:\n    options: \"touch repo-shadow-ran; printf value\"\nsteps:\n  - shell: cat\n    stdin: \"{input.target}\"\n",
    )]);
    let global_file = root.path().join("global-entry.yaml");
    std::fs::write(&global_file, "steps:\n  - shell: \"true\"\n").expect("write global entry");
    let global_label = global_file.to_string_lossy().into_owned();

    let entry = WorkflowListEntry::new("entry".to_string(), Source::Global, global_label.clone());
    let workflow = load_workflow_entry(&entry, &dirs, &no_agents(), true).expect("load entry");
    assert_eq!(workflow.file, global_label);
    assert!(
        !root.path().join("repo-shadow-ran").exists(),
        "repo shadow must not be loaded"
    );
}

#[test]
fn exact_global_entry_records_repo_owned_composition() {
    let (root, _global, dirs) = repo_with(&[("child", "steps:\n  - shell: \"true\"\n")]);
    let global_file = root.path().join("global-entry.yaml");
    std::fs::write(&global_file, "steps:\n  - run: child\n").expect("write global entry");

    let entry = WorkflowListEntry::new(
        "global-entry".to_string(),
        Source::Global,
        global_file.to_string_lossy().into_owned(),
    );
    let workflow = load_workflow_entry(&entry, &dirs, &no_agents(), true).expect("load entry");
    assert!(workflow.repo_owned);
}
