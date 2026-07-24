//! Ported parse/refine/steps assertions from `test/workflows.test.ts` and
//! `test/parse-workflow-text.test.ts`. Only the cases owned by task 1.4
//! (parse + refine + step placeholder/agent rules) are ported; composition,
//! inputs, and substitution assertions land with tasks 1.5/1.6.

use std::collections::HashSet;

use herdr_workflows::workflow::entry::parse_entry;
use herdr_workflows::workflow::errors::WorkflowLoadError;
use herdr_workflows::workflow::steps::{
    FlatStep, flat_needs_invoking_agent, flat_needs_prompt, flat_needs_session,
};

fn agents(names: &[&str]) -> HashSet<String> {
    names.iter().map(|s| (*s).to_string()).collect()
}

fn no_agents() -> HashSet<String> {
    HashSet::new()
}

fn load_err(label: &str, yaml: &str, agents: &HashSet<String>) -> String {
    match parse_entry(label, yaml, agents) {
        Ok(_) => panic!("expected load error for {yaml:?}"),
        Err(e) => e.to_string(),
    }
}

// --- "workflow schema" describe ---

#[test]
fn valid_shell_stdin_parses() {
    let entry = parse_entry(
        "ok.yaml",
        "steps:\n  - shell: echo hi\n    stdin: \"{pane}\"\n",
        &no_agents(),
    )
    .expect("valid workflow");
    assert_eq!(
        entry.steps,
        vec![FlatStep::Shell {
            command: "echo hi".to_string(),
            stdin: Some("{pane}".to_string()),
        }]
    );
}

#[test]
fn two_verbs_rejected_with_step_position() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - shell: echo\n    open: lazygit\n",
        &no_agents(),
    );
    assert!(err.contains("step 1"), "{err}");
}

#[test]
fn modifier_on_wrong_verb_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - open: lazygit\n    prompt: hi\n",
        &no_agents(),
    );
    assert!(err.contains("step 1, prompt"), "{err}");
}

#[test]
fn modifier_on_run_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - run: other\n    stdin: x\n",
        &no_agents(),
    );
    assert!(err.contains("step 1"), "{err}");
}

#[test]
fn unknown_top_level_key_rejected() {
    let err = load_err(
        "bad.yaml",
        "retries: 3\nsteps:\n  - shell: \"true\"\n",
        &no_agents(),
    );
    assert!(err.contains("retries"), "{err}");
}

#[test]
fn empty_steps_rejected() {
    let err = load_err("bad.yaml", "steps: []\n", &no_agents());
    assert!(err.contains("steps"), "{err}");
}

#[test]
fn unknown_agent_rejected_at_load() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - agent: gemini\n    prompt: hi\n",
        &agents(&["claude"]),
    );
    assert!(err.contains("gemini"), "{err}");
}

#[test]
fn agent_placeholder_accepted_at_load() {
    let entry = parse_entry(
        "ok.yaml",
        "steps:\n  - agent: \"{agent}\"\n    prompt: hi\n",
        &agents(&["claude"]),
    )
    .expect("valid workflow");
    assert_eq!(
        entry.steps[0],
        FlatStep::Agent {
            name: "{agent}".to_string(),
            prompt: Some("hi".to_string()),
            wait: false,
            timeout_ms: None,
            close_source: false,
        }
    );
    assert!(flat_needs_invoking_agent(&entry.steps));
}

#[test]
fn wait_on_shell_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - shell: echo hi\n    wait: done\n",
        &no_agents(),
    );
    assert!(err.contains("wait only allowed on agent"), "{err}");
}

#[test]
fn wait_for_on_agent_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - agent: claude\n    wait_for: ready\n",
        &agents(&["claude"]),
    );
    assert!(err.contains("wait_for only allowed on open"), "{err}");
}

#[test]
fn timeout_without_wait_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - shell: echo hi\n    timeout: 10\n",
        &no_agents(),
    );
    assert!(err.contains("timeout requires wait or wait_for"), "{err}");
}

#[test]
fn wait_whatever_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - agent: claude\n    wait: whatever\n",
        &agents(&["claude"]),
    );
    assert!(err.contains("wait"), "{err}");
}

#[test]
fn valid_wait_and_wait_for_parse_to_flat_steps_with_timeout_ms() {
    let yaml = "steps:\n  - agent: claude\n    prompt: hi\n    wait: done\n  - open: bun run dev\n    wait_for: \"Listening on :3000\"\n    timeout: 45\n";
    let entry = parse_entry("ok.yaml", yaml, &agents(&["claude"])).expect("valid workflow");
    assert_eq!(
        entry.steps,
        vec![
            FlatStep::Agent {
                name: "claude".to_string(),
                prompt: Some("hi".to_string()),
                wait: true,
                timeout_ms: Some(1_800_000),
                close_source: false,
            },
            FlatStep::Open {
                command: "bun run dev".to_string(),
                wait_for: Some("Listening on :3000".to_string()),
                timeout_ms: Some(45_000),
            },
        ]
    );
}

// --- "substitution safety" describe (load-time checks only) ---

#[test]
fn placeholder_in_shell_command_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - shell: \"echo {pane}\"\n",
        &no_agents(),
    );
    assert!(err.contains("step 1"), "{err}");
    assert!(err.contains("placeholder {pane}"), "{err}");
}

#[test]
fn placeholder_in_open_command_rejected() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - open: \"echo {selection}\"\n",
        &no_agents(),
    );
    assert!(err.contains("step 1"), "{err}");
}

#[test]
fn session_in_prompt_is_load_error() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - agent: claude\n    prompt: \"{session}\"\n",
        &agents(&["claude"]),
    );
    assert!(
        err.contains("{session}/{session_file} only allowed in stdin"),
        "{err}"
    );
}

#[test]
fn session_in_stdin_ok_and_needs_session() {
    let entry = parse_entry(
        "ok.yaml",
        "steps:\n  - shell: cat\n    stdin: \"{session}\"\n",
        &no_agents(),
    )
    .expect("valid workflow");
    assert!(flat_needs_session(&entry.steps));
    assert_eq!(
        entry.steps,
        vec![FlatStep::Shell {
            command: "cat".to_string(),
            stdin: Some("{session}".to_string()),
        }]
    );
}

#[test]
fn session_file_in_prompt_is_load_error() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - agent: claude\n    prompt: \"{session_file}\"\n",
        &agents(&["claude"]),
    );
    assert!(
        err.contains("{session}/{session_file} only allowed in stdin"),
        "{err}"
    );
}

#[test]
fn session_file_in_stdin_ok_and_needs_session() {
    let entry = parse_entry(
        "ok.yaml",
        "steps:\n  - shell: cat\n    stdin: \"{session_file}\"\n",
        &no_agents(),
    )
    .expect("valid workflow");
    assert!(flat_needs_session(&entry.steps));
}

#[test]
fn workflow_without_session_has_needs_session_false() {
    let entry = parse_entry("ok.yaml", "steps:\n  - shell: \"true\"\n", &no_agents())
        .expect("valid workflow");
    assert!(!flat_needs_session(&entry.steps));
}

#[test]
fn session_in_params_array_is_load_error() {
    let err = load_err(
        "bad.yaml",
        "steps:\n  - herdr: pane.send\n    params:\n      items: [\"{session}\"]\n",
        &no_agents(),
    );
    assert!(
        err.contains("{session}/{session_file} only allowed in stdin"),
        "{err}"
    );
}

#[test]
fn prompt_in_params_sets_needs_prompt() {
    let entry = parse_entry(
        "wf.yaml",
        "steps:\n  - herdr: pane.send\n    params:\n      items: [\"x\", { prompt: \"{prompt}\" }]\n",
        &no_agents(),
    )
    .expect("valid workflow");
    assert!(flat_needs_prompt(&entry.steps));
}

#[test]
fn input_placeholder_in_shell_command_rejected() {
    let err = load_err(
        "wf.yaml",
        "inputs:\n  x: {}\nsteps:\n  - shell: \"echo {input.x}\"\n",
        &no_agents(),
    );
    assert!(err.contains("input.x"), "{err}");
    assert!(err.contains("not allowed in command"), "{err}");
}

// --- "parseWorkflowText parity" describe ---

#[test]
fn valid_buffer_parses_to_flat_steps() {
    let entry = parse_entry(
        "ok.yaml",
        "steps:\n  - shell: echo hi\n    stdin: \"{pane}\"\n",
        &no_agents(),
    )
    .expect("valid buffer");
    assert_eq!(
        entry.steps,
        vec![FlatStep::Shell {
            command: "echo hi".to_string(),
            stdin: Some("{pane}".to_string()),
        }]
    );
    assert!(!flat_needs_prompt(&entry.steps));
}

#[test]
fn invalid_buffer_produces_positioned_error() {
    let err = load_err("bad.yaml", "steps:\n  - shell: echo {pane}\n", &no_agents());
    assert_eq!(
        err,
        "bad.yaml, step 1: placeholder {pane} not allowed in command strings (use stdin/prompt/params)"
    );
}

// --- WorkflowLoadError ---

#[test]
fn workflow_load_error_is_a_std_error() {
    fn assert_error<T: std::error::Error>(_: &T) {}
    let err = WorkflowLoadError("x".to_string());
    assert_error(&err);
    assert_eq!(err.to_string(), "x");
}
