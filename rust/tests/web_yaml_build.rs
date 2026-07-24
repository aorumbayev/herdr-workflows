//! Port of `test/yaml-build.test.ts`: `dump_workflow` output must round-trip
//! through `parse_raw` byte-exact. Corpus unchanged from the TS suite.

use std::collections::BTreeMap;

use herdr_workflows::web::yaml_build::dump_workflow;
use herdr_workflows::workflow::parse::parse_raw;
use herdr_workflows::workflow::types::{RawInput, RawOptions, RawStep, RawWorkflow};

fn round_trip(doc: &RawWorkflow) -> RawWorkflow {
    parse_raw("buf.yaml", &dump_workflow(doc)).expect("dumped YAML must re-parse")
}

fn step_shell(shell: &str) -> RawStep {
    RawStep {
        shell: Some(shell.to_string()),
        ..RawStep::default()
    }
}

fn doc_steps(steps: Vec<RawStep>) -> RawWorkflow {
    RawWorkflow {
        inputs: None,
        input_order: Vec::new(),
        steps,
        on_fail: None,
    }
}

#[test]
fn yaml_typed_scalars_stay_strings() {
    for v in [
        "123", "1.5", "true", "True", "FALSE", "null", "~", "0x10", "1e3", ".nan", "+7",
    ] {
        let doc = round_trip(&doc_steps(vec![step_shell(&format!("echo {v}"))]));
        assert_eq!(
            doc.steps[0].shell.as_deref(),
            Some(format!("echo {v}").as_str())
        );
        let run = round_trip(&doc_steps(vec![RawStep {
            run: Some(v.to_string()),
            ..RawStep::default()
        }]));
        assert_eq!(run.steps[0].run.as_deref(), Some(v));
    }
}

#[test]
fn trailing_colon_and_mapping_comment_traps_are_quoted() {
    for v in ["note:", "a: b", "has # hash", "# leading", "- dash"] {
        let doc = round_trip(&doc_steps(vec![step_shell(v)]));
        assert_eq!(doc.steps[0].shell.as_deref(), Some(v));
    }
}

#[test]
fn multi_line_values_round_trip_byte_exact() {
    for v in [
        "line1  \nline2",
        "foo\n\n\n",
        "  indented\nok",
        "a\nb",
        "quote \"me\"\nnow",
    ] {
        let doc = round_trip(&doc_steps(vec![RawStep {
            agent: Some("claude".to_string()),
            prompt: Some(v.to_string()),
            ..RawStep::default()
        }]));
        assert_eq!(doc.steps[0].prompt.as_deref(), Some(v));
    }
}

#[test]
fn input_values_that_look_like_yaml_scalars_stay_strings() {
    let mut inputs = BTreeMap::new();
    inputs.insert(
        "target".to_string(),
        RawInput {
            label: Some("pick: one".to_string()),
            options: None,
            default: None,
        },
    );
    inputs.insert(
        "plain".to_string(),
        RawInput {
            label: None,
            options: None,
            default: Some("true".to_string()),
        },
    );
    let doc = round_trip(&RawWorkflow {
        inputs: Some(inputs),
        input_order: vec!["target".to_string(), "plain".to_string()],
        steps: vec![step_shell("echo hi")],
        on_fail: None,
    });
    let inputs = doc.inputs.expect("inputs survive");
    assert_eq!(inputs["target"].label.as_deref(), Some("pick: one"));
    assert_eq!(inputs["plain"].default.as_deref(), Some("true"));
}

#[test]
fn options_command_and_choices_round_trip() {
    let mut inputs = BTreeMap::new();
    inputs.insert(
        "branch".to_string(),
        RawInput {
            label: None,
            options: Some(RawOptions::Command("git branch --show".to_string())),
            default: None,
        },
    );
    inputs.insert(
        "env".to_string(),
        RawInput {
            label: None,
            options: Some(RawOptions::Choices(vec![
                "staging".to_string(),
                "prod".to_string(),
            ])),
            default: None,
        },
    );
    let doc = round_trip(&RawWorkflow {
        inputs: Some(inputs),
        input_order: vec!["branch".to_string(), "env".to_string()],
        steps: vec![step_shell("echo hi")],
        on_fail: None,
    });
    let inputs = doc.inputs.expect("inputs survive");
    assert_eq!(
        inputs["branch"].options,
        Some(RawOptions::Command("git branch --show".to_string()))
    );
    assert_eq!(
        inputs["env"].options,
        Some(RawOptions::Choices(vec![
            "staging".to_string(),
            "prod".to_string()
        ]))
    );
}

#[test]
fn blank_line_separates_steps_and_on_fail() {
    let mut agent = RawStep {
        agent: Some("claude".to_string()),
        prompt: Some("go".to_string()),
        ..RawStep::default()
    };
    agent.wait = Some(herdr_workflows::workflow::types::WaitDone::Done);
    let doc = doc_steps(vec![step_shell("echo hi"), agent]);
    let text = dump_workflow(&RawWorkflow {
        on_fail: Some("cleanup".to_string()),
        ..doc.clone()
    });
    assert!(text.contains("\n\n  - agent: claude"), "got: {text}");
    assert!(text.contains("    wait: done\n"), "got: {text}");
    assert!(text.ends_with("\n\non_fail: cleanup\n"), "got: {text}");
    let reparsed = round_trip(&RawWorkflow {
        on_fail: Some("cleanup".to_string()),
        ..doc
    });
    assert_eq!(reparsed.on_fail.as_deref(), Some("cleanup"));
}
