//! Config load/merge: repo `.hwf/config.yaml` + `~/.hwf/config.yaml`.
//! Port of `src/config.ts`.

// Consumers (cli, runner, web) land in later tasks; nothing calls this yet.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::Deserialize;
use thiserror::Error;

/// Agent name → argv template with exactly one `{prompt}` element.
pub type AgentsConfig = BTreeMap<String, Vec<String>>;
/// Session name → argv template.
pub type SessionsConfig = BTreeMap<String, Vec<String>>;

/// Merged `.hwf/config.yaml` view. Mirrors `WorkflowsConfig` in `src/config.ts`:
/// `agents` is required, `sessions` defaults to empty, unknown keys are rejected
/// (Zod `.strict()` ↔ `deny_unknown_fields`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkflowsConfig {
    pub agents: AgentsConfig,
    #[serde(default)]
    pub sessions: SessionsConfig,
}

/// Load/validation failure; the message is the positioned TS-format string
/// (`file, key: message` or `file: message`).
#[derive(Debug, Error)]
#[error("{0}")]
pub struct ConfigLoadError(String);

fn positioned(file: &Path, key: Option<&str>, message: &str) -> String {
    match key {
        Some(key) => format!("{}, {key}: {message}", file.display()),
        None => format!("{}: {message}", file.display()),
    }
}

/// Cross-field rules from the Zod schema (`min(1)` argv arrays, exactly one
/// `{prompt}` slot per agent). Returns `(key, message)` issue pairs.
fn validate(cfg: &WorkflowsConfig) -> Vec<(String, String)> {
    let mut issues = Vec::new();
    for (name, argv) in &cfg.agents {
        if argv.is_empty() {
            issues.push((
                format!("agents.{name}"),
                "Too small: expected array to have >=1 items".to_string(),
            ));
        }
        let slots = argv.iter().filter(|a| a.as_str() == "{prompt}").count();
        if slots != 1 {
            issues.push((
                format!("agents.{name}"),
                format!("agent '{name}' must contain exactly one \"{{prompt}}\" argv element"),
            ));
        }
    }
    for (name, argv) in &cfg.sessions {
        if argv.is_empty() {
            issues.push((
                format!("sessions.{name}"),
                "Too small: expected array to have >=1 items".to_string(),
            ));
        }
    }
    issues
}

/// Validate a config YAML buffer through the same checks `load_config` uses.
///
/// # Errors
/// Returns [`ConfigLoadError`] on YAML syntax errors, schema violations
/// (unknown keys, wrong types), or `{prompt}`-slot / min-length failures.
pub fn parse_config_text(file: &Path, text: &str) -> Result<WorkflowsConfig, ConfigLoadError> {
    let cfg: WorkflowsConfig = serde_yml::from_str(text)
        .map_err(|e| ConfigLoadError(positioned(file, None, &e.to_string())))?;
    let issues = validate(&cfg);
    if issues.is_empty() {
        Ok(cfg)
    } else {
        let message = issues
            .iter()
            .map(|(key, message)| positioned(file, Some(key), message))
            .collect::<Vec<_>>()
            .join("; ");
        Err(ConfigLoadError(message))
    }
}

fn load_file(file: &Path) -> Result<Option<WorkflowsConfig>, ConfigLoadError> {
    match std::fs::read_to_string(file) {
        Ok(text) => parse_config_text(file, &text).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigLoadError(positioned(file, None, &e.to_string()))),
    }
}

/// `~/.hwf/config.yaml`, honoring the `HOME` env var like the TS `homedir()` fallback.
#[must_use]
pub fn global_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
        .join(".hwf")
        .join("config.yaml")
}

/// `<repoRoot>/.hwf/config.yaml`.
#[must_use]
pub fn repo_config_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".hwf").join("config.yaml")
}

/// Merge global then repo; repo wins per name for agents and sessions independently.
///
/// # Errors
/// Returns [`ConfigLoadError`] if either present config file fails to parse or validate.
pub fn load_config(repo_root: &Path) -> Result<WorkflowsConfig, ConfigLoadError> {
    load_config_paths(&global_config_path(), &repo_config_path(repo_root))
}

/// `load_config` with explicit file paths so tests stay parallel-safe (no `HOME` mutation).
fn load_config_paths(
    global_file: &Path,
    repo_file: &Path,
) -> Result<WorkflowsConfig, ConfigLoadError> {
    let global = load_file(global_file)?.unwrap_or_default();
    let repo = load_file(repo_file)?.unwrap_or_default();
    let mut agents = global.agents;
    agents.extend(repo.agents);
    let mut sessions = global.sessions;
    sessions.extend(repo.sessions);
    Ok(WorkflowsConfig { agents, sessions })
}

/// Substitute the single `{prompt}` element, keeping the prompt as one argv item.
#[must_use]
pub fn fill_agent_argv(template: &[String], prompt: &str) -> Vec<String> {
    template
        .iter()
        .map(|part| {
            if part == "{prompt}" {
                prompt.to_string()
            } else {
                part.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("hwf-config-{tag}-{}", uuid::Uuid::new_v4()));
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

    fn write_config(dir: &Path, body: &str) -> PathBuf {
        let file = dir.join(".hwf").join("config.yaml");
        std::fs::create_dir_all(file.parent().expect("config path has parent"))
            .expect("create .hwf dir");
        std::fs::write(&file, body).expect("write config");
        file
    }

    fn missing_file(dir: &TempDir) -> PathBuf {
        dir.path().join("no-such-config.yaml")
    }

    #[test]
    fn repo_overrides_global_agent() {
        let home = TempDir::new("home");
        let root = TempDir::new("repo");
        let global_file = write_config(home.path(), "agents:\n  claude: [\"claude\", \"{prompt}\"]\n");
        let repo_file =
            write_config(root.path(), "agents:\n  claude: [\"claude\", \"--print\", \"{prompt}\"]\n");
        assert_eq!(
            repo_config_path(root.path()),
            root.path().join(".hwf").join("config.yaml")
        );
        let cfg = load_config_paths(&global_file, &repo_file).expect("load config");
        assert_eq!(
            cfg.agents.get("claude"),
            Some(&vec![
                "claude".to_string(),
                "--print".to_string(),
                "{prompt}".to_string()
            ])
        );
    }

    #[test]
    fn global_config_path_lives_under_home() {
        assert!(
            global_config_path().ends_with(Path::new(".hwf").join("config.yaml")),
            "global config path must be <home>/.hwf/config.yaml"
        );
    }

    #[test]
    fn unknown_key_rejected() {
        let root = TempDir::new("repo");
        let repo_file = write_config(root.path(), "agents: {}\nretries: 1\n");
        let err = load_config_paths(&missing_file(&root), &repo_file).expect_err("must fail");
        assert!(
            err.to_string().contains("retries"),
            "error must name the unknown key, got: {err}"
        );
    }

    #[test]
    fn missing_prompt_slot_rejected_with_ts_message() {
        let root = TempDir::new("repo");
        let repo_file = write_config(root.path(), "agents:\n  claude: [\"claude\"]\n");
        let err = load_config_paths(&missing_file(&root), &repo_file).expect_err("must fail");
        let expected = format!(
            "{}, agents.claude: agent 'claude' must contain exactly one \"{{prompt}}\" argv element",
            repo_file.display()
        );
        assert_eq!(err.to_string(), expected);
    }

    #[test]
    fn empty_argv_reports_min_length_and_prompt_slot() {
        let root = TempDir::new("repo");
        let repo_file = write_config(root.path(), "agents:\n  claude: []\n");
        let err = load_config_paths(&missing_file(&root), &repo_file).expect_err("must fail");
        let expected = format!(
            "{0}, agents.claude: Too small: expected array to have >=1 items; \
             {0}, agents.claude: agent 'claude' must contain exactly one \"{{prompt}}\" argv element",
            repo_file.display()
        );
        assert_eq!(err.to_string(), expected);
    }

    #[test]
    fn sessions_parse_repo_overrides_global_per_name() {
        let home = TempDir::new("home");
        let root = TempDir::new("repo");
        let global_file = write_config(
            home.path(),
            "agents: {}\nsessions:\n  codex: [\"echo\", \"global\"]\n  claude: [\"echo\", \"g-claude\"]\n",
        );
        let repo_file = write_config(
            root.path(),
            "agents: {}\nsessions:\n  codex: [\"echo\", \"repo\"]\n",
        );
        let cfg = load_config_paths(&global_file, &repo_file).expect("load config");
        assert_eq!(
            cfg.sessions.get("codex"),
            Some(&vec!["echo".to_string(), "repo".to_string()])
        );
        assert_eq!(
            cfg.sessions.get("claude"),
            Some(&vec!["echo".to_string(), "g-claude".to_string()])
        );
    }

    #[test]
    fn fill_agent_argv_replaces_prompt_as_one_element() {
        let argv = fill_agent_argv(&["claude".to_string(), "{prompt}".to_string()], "line1\nline2");
        assert_eq!(argv, vec!["claude".to_string(), "line1\nline2".to_string()]);
    }
}
