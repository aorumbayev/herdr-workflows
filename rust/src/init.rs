//! `hwf init`: seed `.hwf/config.yaml` + starter workflows, detect agents on
//! `PATH`, seed handoff/worktree playbooks into the repo or `~/.hwf`. Port of
//! `src/init.ts` + `src/seed-workflows.ts` + `src/playbook-scope.ts` + the
//! `init` arm of `src/cmd-init.ts`. Seed bodies were TS string literals, so
//! they are Rust string constants here (design: no asset files for literals).

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::config::{AgentsConfig, repo_config_path};

/// Agent name → binary → argv template, in preference order. The first
/// detected name is the one seeds embed (the TS `KNOWN_AGENTS` ranking).
const KNOWN_AGENTS: &[(&str, &str, &[&str])] = &[
    ("claude", "claude", &["claude", "{prompt}"]),
    ("codex", "codex", &["codex", "{prompt}"]),
    ("aider", "aider", &["aider", "--message", "{prompt}"]),
    ("cursor", "cursor", &["cursor", "agent", "{prompt}"]),
];

/// Where the handoff/worktree playbooks land. `skip` seeds neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybookSeedScope {
    Skip,
    Global,
    Repo,
}

/// `parsePlaybookSeedScope`: trim/lowercase, aliases `g`/`global`,
/// `r`/`repo`/`local`/`cwd`, `n`/`none`/`skip`/`no`; anything else is `None`.
#[must_use]
pub fn parse_playbook_seed_scope(raw: &str) -> Option<PlaybookSeedScope> {
    match raw.trim().to_lowercase().as_str() {
        "g" | "global" => Some(PlaybookSeedScope::Global),
        "r" | "repo" | "local" | "cwd" => Some(PlaybookSeedScope::Repo),
        "n" | "none" | "skip" | "no" => Some(PlaybookSeedScope::Skip),
        _ => None,
    }
}

/// `which <bin>` exits 0 — the TS `onPath` check.
fn on_path(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// `detectAgents`: every known agent whose binary is on `PATH`.
#[must_use]
pub fn detect_agents() -> AgentsConfig {
    KNOWN_AGENTS
        .iter()
        .filter(|(_, bin, _)| on_path(bin))
        .map(|(name, _, argv)| {
            (
                (*name).to_string(),
                argv.iter().map(|arg| (*arg).to_string()).collect(),
            )
        })
        .collect()
}

/// `formatAgentsYaml`: `agents:` block, names sorted (`BTreeMap` order), each
/// argv element JSON-quoted like the TS `JSON.stringify`.
#[must_use]
pub fn format_agents_yaml(agents: &AgentsConfig) -> String {
    let mut out = String::from("agents:\n");
    if agents.is_empty() {
        out.push_str("  {}\n");
        return out;
    }
    for (name, argv) in agents {
        let parts: Vec<String> = argv
            .iter()
            .map(|arg| serde_json::to_string(arg).expect("JSON-encoding a &str cannot fail"))
            .collect();
        out.push_str(&format!("  {name}: [{}]\n", parts.join(", ")));
    }
    out
}

/// A named workflow file body. `body` takes the first-detected agent name.
pub struct Seed {
    pub name: &'static str,
    pub body: fn(&str) -> String,
}

const HANDOFF_BODY: &str = r#"inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: cat
    stdin: "{session}"
  - agent: "{agent}"
    prompt: |
      Below the --- marker is a coding agent session transcript. Distil it into
      a handoff prompt for a fresh agent session.

      Keep (signal):
      - architectural decisions with their rationale
      - working solutions adopted (final approach, not the journey)
      - configuration choices: versions, settings, flags, env vars
      - files created/modified with paths and why
      - constraints discovered: API limits, compatibility issues, platform quirks
      - productive dead ends, one sentence each: what was tried, why it failed,
        what it means for remaining work
      - open questions and unresolved trade-offs
      - anything the next session would otherwise re-discover

      Drop (noise):
      - corrections and retries: keep only the final correct version
      - verbose tool output: summarise builds, tests, diffs
      - permission prompts and settled back-and-forth
      - repeated attempts: describe the working one once

      Compression: error-fix cycles reduce to root cause + fix; explorations
      collapse to their conclusion; long discussions reduce to the decision and
      key reason.

      Output ONLY the handoff prompt, second-person imperative, in this shape
      (omit empty sections):

      Continue the work from the previous session. Here is the context you need:

      **Project**: <path>
      **Branch**: <branch, if known>

      ## Background
      ## What was done
      ## Decisions in effect
      ## Current state
      ## Open questions
      ## Your next steps
      1. <directive>

      Never invent decisions or context not present in the transcript; note
      unclear items as open questions.

      ---
      {last}
    wait: done
    timeout: 900
  - agent: "{input.target}"
    prompt: |
      Focus: {input.focus}

      {last}
    close_source: true
"#;

const WORKTREE_BODY: &str = r#"inputs:
  branch:
    label: new branch name
  base:
    options: [main, develop]
    default: main
steps:
  - shell: herdr worktree create --branch "$HWF_INPUT_branch" --base "$HWF_INPUT_base" --label "$HWF_INPUT_branch" --focus
"#;

fn handoff_body(_agent: &str) -> String {
    HANDOFF_BODY.to_string()
}

fn worktree_body(_agent: &str) -> String {
    WORKTREE_BODY.to_string()
}

fn review_body(agent: &str) -> String {
    format!(
        "steps:\n  - shell: git diff HEAD\n  - agent: {}\n    prompt: |\n      Review this diff. List blocking issues only.\n\n      {{last}}\n    wait: done\n    timeout: 900\n",
        serde_json::to_string(agent).expect("JSON-encoding a &str cannot fail")
    )
}

/// Shared playbooks (handoff, worktree); seeded into the repo or `~/.hwf`
/// depending on the scope.
pub static PLAYBOOK_SEED_WORKFLOWS: &[Seed] = &[
    Seed {
        name: "handoff",
        body: handoff_body,
    },
    Seed {
        name: "worktree",
        body: worktree_body,
    },
];

/// Always seeded into the repo on init (when an agent is detected).
pub static REPO_SEED_WORKFLOWS: &[Seed] = &[Seed {
    name: "review",
    body: review_body,
}];

/// `seedWorkflows`: write each seed into `dir` as `<name>.yaml`, skipping
/// files that already exist. Returns the names actually written.
///
/// # Errors
/// Propagates directory-create / file-write failures.
pub fn seed_workflows(dir: &Path, agent: &str, seeds: &[Seed]) -> std::io::Result<Vec<String>> {
    let mut written = Vec::new();
    std::fs::create_dir_all(dir)?;
    for seed in seeds {
        let file = dir.join(format!("{}.yaml", seed.name));
        if file.exists() {
            continue;
        }
        std::fs::write(&file, (seed.body)(agent))?;
        written.push(seed.name.to_string());
    }
    Ok(written)
}

/// Payload for the two writing outcomes of [`run_init`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitWritten {
    pub path: PathBuf,
    pub agents: Vec<String>,
    pub workflows: Vec<String>,
    pub global_workflows: Vec<String>,
    pub playbook_scope: PlaybookSeedScope,
}

/// `InitResult`: `Exists` when the config was kept (no `--force`, no `y`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InitResult {
    Wrote(InitWritten),
    Overwritten(InitWritten),
    Exists(PathBuf),
}

/// `runInit` options. Callbacks keep TTY behavior out of the library half;
/// `home` overrides `HOME` so tests stay hermetic.
#[derive(Default)]
pub struct InitOptions<'a> {
    pub force: bool,
    pub playbook_scope: Option<PlaybookSeedScope>,
    pub confirm: Option<&'a dyn Fn() -> bool>,
    pub choose_playbook_scope: Option<&'a dyn Fn() -> PlaybookSeedScope>,
    pub home: Option<&'a Path>,
}

/// `runInit`: write `.hwf/config.yaml` (+ global config when absent), seed
/// workflows. Default scope is `global` when neither option is set
/// (non-interactive).
///
/// # Errors
/// Propagates filesystem failures (mkdir/write).
pub fn run_init(repo_root: &Path, opts: &InitOptions) -> std::io::Result<InitResult> {
    let path = repo_config_path(repo_root);
    let existed = path.exists();
    if existed
        && !opts.force
        && !opts.confirm.is_some_and(|confirm| confirm())
    {
        return Ok(InitResult::Exists(path));
    }

    let agents = detect_agents();
    let home = opts
        .home
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(std::env::home_dir)
        .unwrap_or_default();
    let global_cfg = home.join(".hwf").join("config.yaml");
    let global_dir = home.join(".hwf").join("workflows");
    let workflows_dir = repo_root.join(".hwf").join("workflows");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(&workflows_dir)?;
    if let Some(parent) = global_cfg.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(&global_dir)?;

    std::fs::write(&path, format_agents_yaml(&agents))?;
    if !global_cfg.exists() {
        std::fs::write(&global_cfg, format_agents_yaml(&agents))?;
    }

    // Detection order, not alphabetical — KNOWN_AGENTS is the preference ranking.
    let first = KNOWN_AGENTS
        .iter()
        .map(|(name, _, _)| *name)
        .find(|name| agents.contains_key(*name));
    let playbook_scope = opts
        .playbook_scope
        .or_else(|| opts.choose_playbook_scope.map(|choose| choose()))
        .unwrap_or(PlaybookSeedScope::Global);

    let mut workflows = Vec::new();
    let mut global_workflows = Vec::new();
    if let Some(first) = first {
        workflows = seed_workflows(&workflows_dir, first, REPO_SEED_WORKFLOWS)?;
        match playbook_scope {
            PlaybookSeedScope::Repo => {
                workflows.extend(seed_workflows(
                    &workflows_dir,
                    first,
                    PLAYBOOK_SEED_WORKFLOWS,
                )?);
            }
            PlaybookSeedScope::Global => {
                global_workflows =
                    seed_workflows(&global_dir, first, PLAYBOOK_SEED_WORKFLOWS)?;
            }
            PlaybookSeedScope::Skip => {}
        }
    }

    let written = InitWritten {
        path,
        agents: agents.keys().cloned().collect(),
        workflows,
        global_workflows,
        playbook_scope,
    };
    Ok(if existed {
        InitResult::Overwritten(written)
    } else {
        InitResult::Wrote(written)
    })
}

/// `promptLine`: write the prompt (no newline), read one stdin line.
/// `None` on EOF — the TS `line.kind !== "line"` case.
fn prompt_line(prompt: &str) -> Option<String> {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_string()),
    }
}

/// CLI `init` arm (`cmdInit`). `seed` is the raw `--seed`/`--seed-playbooks`
/// value. Prints the TS summary on success.
///
/// # Errors
/// The message for every TS `die(...)` case (bad `--seed`, config exists);
/// the caller prints it to stderr and exits 1.
pub fn cmd_init(repo_root: &Path, force: bool, seed: Option<&str>) -> Result<(), String> {
    let playbook_scope = seed.and_then(parse_playbook_seed_scope);
    if seed.is_some() && playbook_scope.is_none() {
        return Err("usage: hwf init [--force] [--seed=global|repo|none]".to_string());
    }
    let is_tty = std::io::stdin().is_terminal();
    let confirm = || {
        is_tty
            && prompt_line(".hwf/config.yaml exists — overwrite? [y/N] ")
                .is_some_and(|line| line.trim().eq_ignore_ascii_case("y"))
    };
    let choose = || match prompt_line("Seed handoff + worktree? [g]lobal ~/.hwf / [r]epo .hwf / [n]one [G]: ") {
        None => PlaybookSeedScope::Global,
        Some(line) => {
            parse_playbook_seed_scope(if line.is_empty() { "g" } else { &line })
                .unwrap_or(PlaybookSeedScope::Global)
        }
    };
    let result = run_init(
        repo_root,
        &InitOptions {
            force,
            playbook_scope,
            confirm: Some(&confirm),
            choose_playbook_scope: if playbook_scope.is_some() || !is_tty {
                None
            } else {
                Some(&choose)
            },
            home: None,
        },
    )
    .map_err(|error| error.to_string())?;

    let written = match result {
        InitResult::Exists(path) => {
            return Err(format!(
                "{} already exists (pass --force to overwrite)",
                path.display()
            ));
        }
        InitResult::Wrote(written) | InitResult::Overwritten(written) => written,
    };
    let agents = if written.agents.is_empty() {
        " (no agents on PATH)".to_string()
    } else {
        format!(" ({})", written.agents.join(", "))
    };
    let workflows = if written.workflows.is_empty() {
        String::new()
    } else {
        format!("seeded repo workflows: {}\n", written.workflows.join(", "))
    };
    let global = if written.global_workflows.is_empty() {
        String::new()
    } else {
        format!(
            "seeded global workflows (~/.hwf): {}\n",
            written.global_workflows.join(", ")
        )
    };
    let skipped = if written.playbook_scope == PlaybookSeedScope::Skip
        && written.global_workflows.is_empty()
    {
        "skipped handoff/worktree seeds\n"
    } else {
        ""
    };
    print!(
        "wrote {}{agents}\n{workflows}{global}{skipped}",
        written.path.display()
    );
    Ok(())
}
