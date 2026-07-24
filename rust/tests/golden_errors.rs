//! Golden error corpus harness for the workflow loader.
//!
//! `golden/errors.json` is captured from the TS loader (`src/workflows/*`) and pins the
//! positioned error format `file[, step N][, key]: message` byte-for-byte across the full
//! pipeline (parse/refine/steps/flatten/inputs/recovery). It is the P0 gate.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use herdr_workflows::workflow::discover::WorkflowDirs;
use herdr_workflows::workflow::load::parse_workflow_text;
use serde::Deserialize;

const CORPUS: &str = include_str!("golden/errors.json");
const REPO_ROOT_TOKEN: &str = "{REPO_ROOT}";

#[derive(Deserialize)]
struct Corpus {
    source: String,
    cases: Vec<GoldenCase>,
}

#[derive(Deserialize)]
struct GoldenCase {
    id: String,
    /// Workflow name; the error label is `<name>.yaml`.
    name: String,
    #[serde(default)]
    agents: Vec<String>,
    /// Extra repo workflows written to `<root>/.hwf/workflows/`.
    #[serde(default)]
    files: BTreeMap<String, String>,
    /// The entry yaml is also on disk (run targets resolving back to the entry).
    #[serde(default)]
    entry_on_disk: bool,
    yaml: String,
    expected: String,
}

fn corpus() -> Corpus {
    serde_json::from_str(CORPUS).expect("golden/errors.json must be valid JSON")
}

#[test]
fn corpus_is_well_formed() {
    let corpus = corpus();
    assert!(!corpus.source.is_empty());
    assert!(!corpus.cases.is_empty(), "corpus must contain cases");
    let mut ids = HashSet::new();
    for case in &corpus.cases {
        assert!(ids.insert(&case.id), "duplicate case id '{}'", case.id);
        assert!(!case.yaml.is_empty(), "case '{}': empty yaml", case.id);
        for agent in &case.agents {
            assert!(!agent.is_empty(), "case '{}': empty agent name", case.id);
        }
        let label = format!("{}.yaml", case.name);
        assert!(
            case.expected.starts_with(&label) || case.expected.starts_with(REPO_ROOT_TOKEN),
            "case '{}': expected error must start with the file label, got {:?}",
            case.id,
            case.expected,
        );
        assert!(
            case.expected.contains(": "),
            "case '{}': malformed positioned error {:?}",
            case.id,
            case.expected,
        );
    }
}

/// Write the case's repo tree into a fresh temp dir and return its root.
fn materialize_repo(case: &GoldenCase) -> PathBuf {
    let root = std::env::temp_dir().join(format!("hwf-golden-{}", uuid::Uuid::new_v4()));
    let dir = root.join(".hwf").join("workflows");
    std::fs::create_dir_all(&dir).expect("create workflows dir");
    for (name, body) in &case.files {
        std::fs::write(dir.join(format!("{name}.yaml")), body).expect("write workflow file");
    }
    if case.entry_on_disk {
        std::fs::write(dir.join(format!("{}.yaml", case.name)), &case.yaml)
            .expect("write entry workflow");
    }
    root
}

/// Expand the `{REPO_ROOT}` token the extractor substituted for the temp repo root.
fn denormalize(expected: &str, root: &Path) -> String {
    expected.replace(
        REPO_ROOT_TOKEN,
        root.to_str().expect("temp root must be UTF-8"),
    )
}

/// Byte-identical comparison of every corpus case against the full Rust loader
/// (`parse_workflow_text` with `resolve_dynamic = true`, matching the extractor's
/// `parseWorkflowText` call). Like the extractor, `HOME` is neutralized by
/// pointing the global workflows dir at the temp repo root.
#[test]
fn golden_errors_match_ts_loader() {
    let corpus = corpus();
    let mut checked = 0;
    for case in &corpus.cases {
        checked += 1;
        let root = materialize_repo(case);
        let expected = denormalize(&case.expected, &root);
        let agents: HashSet<String> = case.agents.iter().cloned().collect();
        let label = format!("{}.yaml", case.name);
        let dirs = WorkflowDirs {
            repo_root: root.clone(),
            global: root.join(".hwf").join("workflows"),
        };
        let result = parse_workflow_text(&case.name, &case.yaml, &agents, &dirs, &label, true);
        let _ = std::fs::remove_dir_all(&root);
        let Err(err) = result else {
            panic!(
                "case '{}': expected load error {:?}, but the workflow loaded",
                case.id, expected
            );
        };
        assert_eq!(err.to_string(), expected, "case '{}'", case.id);
    }
    assert_eq!(
        checked,
        corpus.cases.len(),
        "every corpus case must be checked"
    );
}
