//! Ported assertions from `test/init.test.ts` — temp-dir based, `home`
//! injected so tests never touch the real `HOME` (the TS suite mutates
//! `process.env.HOME`; the Rust API takes the path instead).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use herdr_workflows::config::{AgentsConfig, parse_config_text};
use herdr_workflows::init::{
    InitOptions, InitResult, PLAYBOOK_SEED_WORKFLOWS, PlaybookSeedScope, REPO_SEED_WORKFLOWS,
    detect_agents, format_agents_yaml, parse_playbook_seed_scope, run_init, seed_workflows,
};
use herdr_workflows::workflow::discover::WorkflowDirs;
use herdr_workflows::workflow::load::load_workflow;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!("hwf-init-{tag}-{}", uuid::Uuid::new_v4()));
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

fn wrote(result: InitResult) -> herdr_workflows::init::InitWritten {
    match result {
        InitResult::Wrote(written) | InitResult::Overwritten(written) => written,
        InitResult::Exists(path) => panic!("expected wrote, got exists: {}", path.display()),
    }
}

#[test]
fn fresh_init_writes_agents_config() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    let detected = detect_agents();
    let result = run_init(
        root.path(),
        &InitOptions {
            playbook_scope: Some(PlaybookSeedScope::Skip),
            home: Some(home.path()),
            ..InitOptions::default()
        },
    )
    .expect("run init");
    let written = wrote(result);
    let text = std::fs::read_to_string(&written.path).expect("read config");
    assert!(text.contains("agents:"));
    let cfg = parse_config_text(&written.path, &text).expect("parse written config");
    for (name, argv) in &detected {
        assert_eq!(cfg.agents.get(name), Some(argv));
    }
}

#[test]
fn existing_config_preserved_without_confirmation() {
    let root = TempDir::new("repo");
    let dir = root.path().join(".hwf");
    std::fs::create_dir_all(&dir).expect("create .hwf");
    let path = dir.join("config.yaml");
    std::fs::write(&path, "agents:\n  claude: [\"claude\", \"{prompt}\"]\n").expect("write config");
    let result = run_init(root.path(), &InitOptions::default()).expect("run init");
    assert!(
        matches!(result, InitResult::Exists(_)),
        "expected exists, got {result:?}"
    );
    let text = std::fs::read_to_string(&path).expect("read config");
    assert!(text.contains("claude"));
}

#[test]
fn format_agents_yaml_emits_prompt_slots() {
    let mut agents = AgentsConfig::new();
    agents.insert(
        "claude".to_string(),
        vec!["claude".to_string(), "{prompt}".to_string()],
    );
    assert!(format_agents_yaml(&agents).contains("\"{prompt}\""));
}

#[test]
fn parse_playbook_seed_scope_accepts_aliases() {
    assert_eq!(
        parse_playbook_seed_scope("G"),
        Some(PlaybookSeedScope::Global)
    );
    assert_eq!(
        parse_playbook_seed_scope("repo"),
        Some(PlaybookSeedScope::Repo)
    );
    assert_eq!(
        parse_playbook_seed_scope("none"),
        Some(PlaybookSeedScope::Skip)
    );
    assert_eq!(parse_playbook_seed_scope("nope"), None);
}

#[test]
fn playbook_seeds_handoff_worktree_review_is_repo_only() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    let repo_dir = root.path().join(".hwf").join("workflows");
    let global_dir = home.path().join(".hwf").join("workflows");
    std::fs::create_dir_all(&repo_dir).expect("create repo workflows dir");

    assert_eq!(
        seed_workflows(&repo_dir, "claude", REPO_SEED_WORKFLOWS).expect("seed repo"),
        vec!["review"]
    );
    let mut playbooks =
        seed_workflows(&global_dir, "claude", PLAYBOOK_SEED_WORKFLOWS).expect("seed playbooks");
    playbooks.sort();
    assert_eq!(playbooks, ["handoff", "worktree"]);

    let handoff = std::fs::read_to_string(global_dir.join("handoff.yaml")).expect("read handoff");
    assert!(handoff.contains("agent: \"{agent}\""));
    assert!(handoff.contains("stdin: \"{session}\""));
    assert!(handoff.contains("close_source: true"));

    let dirs = WorkflowDirs {
        repo_root: root.path().to_path_buf(),
        global: global_dir,
    };
    let agents: HashSet<String> = ["claude".to_string()].into_iter().collect();
    let workflow = load_workflow("handoff", &dirs, &agents).expect("load handoff");
    assert!(workflow.needs_session);
    assert!(workflow.needs_invoking_agent);
}

#[test]
fn run_init_scope_global_seeds_home_handoff_worktree() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    if detect_agents().is_empty() {
        return;
    }
    let written = wrote(
        run_init(
            root.path(),
            &InitOptions {
                playbook_scope: Some(PlaybookSeedScope::Global),
                home: Some(home.path()),
                ..InitOptions::default()
            },
        )
        .expect("run init"),
    );
    assert_eq!(written.playbook_scope, PlaybookSeedScope::Global);
    assert_eq!(written.workflows, ["review"]);
    let mut global = written.global_workflows.clone();
    global.sort();
    assert_eq!(global, ["handoff", "worktree"]);
    assert!(home.path().join(".hwf/workflows/handoff.yaml").exists());
    assert!(!root.path().join(".hwf/workflows/handoff.yaml").exists());
}

#[test]
fn run_init_scope_repo_seeds_handoff_worktree_into_cwd() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    if detect_agents().is_empty() {
        return;
    }
    let written = wrote(
        run_init(
            root.path(),
            &InitOptions {
                playbook_scope: Some(PlaybookSeedScope::Repo),
                home: Some(home.path()),
                ..InitOptions::default()
            },
        )
        .expect("run init"),
    );
    assert_eq!(written.playbook_scope, PlaybookSeedScope::Repo);
    let mut workflows = written.workflows.clone();
    workflows.sort();
    assert_eq!(workflows, ["handoff", "review", "worktree"]);
    assert!(written.global_workflows.is_empty());
    assert!(root.path().join(".hwf/workflows/handoff.yaml").exists());
    assert!(!home.path().join(".hwf/workflows/handoff.yaml").exists());
}

#[test]
fn run_init_scope_skip_leaves_handoff_worktree_unset() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    if detect_agents().is_empty() {
        return;
    }
    let written = wrote(
        run_init(
            root.path(),
            &InitOptions {
                playbook_scope: Some(PlaybookSeedScope::Skip),
                home: Some(home.path()),
                ..InitOptions::default()
            },
        )
        .expect("run init"),
    );
    assert_eq!(written.playbook_scope, PlaybookSeedScope::Skip);
    assert_eq!(written.workflows, ["review"]);
    assert!(written.global_workflows.is_empty());
}

#[test]
fn choose_playbook_scope_callback_is_honored() {
    let root = TempDir::new("repo");
    let home = TempDir::new("home");
    if detect_agents().is_empty() {
        return;
    }
    let written = wrote(
        run_init(
            root.path(),
            &InitOptions {
                choose_playbook_scope: Some(&|| PlaybookSeedScope::Repo),
                home: Some(home.path()),
                ..InitOptions::default()
            },
        )
        .expect("run init"),
    );
    assert_eq!(written.playbook_scope, PlaybookSeedScope::Repo);
    assert!(written.workflows.contains(&"handoff".to_string()));
}
