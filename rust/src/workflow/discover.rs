//! Repo-shadows-global discovery. Port of `src/workflows/discover.ts`.

use std::path::{Path, PathBuf};

use super::errors::{Source, WorkflowListEntry};

/// `~/.hwf/workflows`, honoring `HOME` like the TS `homedir()` fallback.
#[must_use]
pub fn global_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
        .join(".hwf")
        .join("workflows")
}

/// `<repoRoot>/.hwf/workflows`.
#[must_use]
pub fn repo_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".hwf").join("workflows")
}

/// The two directories workflows resolve against. Unlike the TS functions
/// (which read `HOME` implicitly), callers pass this in so tests stay
/// hermetic; `for_repo` reproduces the TS default (`global_dir()` from `HOME`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDirs {
    pub repo_root: PathBuf,
    /// The global workflows directory itself (`~/.hwf/workflows`).
    pub global: PathBuf,
}

impl WorkflowDirs {
    /// TS-default dirs: explicit repo root, global from `HOME`.
    #[must_use]
    pub fn for_repo(repo_root: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            global: global_dir(),
        }
    }

    #[must_use]
    pub fn repo_workflows(&self) -> PathBuf {
        repo_dir(&self.repo_root)
    }
}

/// A name resolved to an on-disk file, tagged with its source scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub file: String,
    pub source: Source,
}

/// `*.yaml` basenames (suffix stripped, dotfiles skipped — `Bun.Glob` does not
/// match them), sorted. A missing/unreadable directory yields an empty list,
/// matching the TS `try/catch → []`.
fn yaml_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .filter_map(|name| name.strip_suffix(".yaml").map(str::to_string))
        .collect();
    names.sort();
    names
}

/// `workflowPath`: the on-disk path for `name` in the given scope.
#[must_use]
pub fn workflow_path(scope: Source, dirs: &WorkflowDirs, name: &str) -> PathBuf {
    match scope {
        Source::Repo => dirs.repo_workflows(),
        Source::Global => dirs.global.clone(),
    }
    .join(format!("{name}.yaml"))
}

/// `resolveWorkflowFile`: repo wins over global; `None` when neither has it.
#[must_use]
pub fn resolve_workflow_file(name: &str, dirs: &WorkflowDirs) -> Option<Resolved> {
    let repo = dirs.repo_workflows().join(format!("{name}.yaml"));
    if repo.exists() {
        return Some(Resolved {
            file: repo.to_string_lossy().into_owned(),
            source: Source::Repo,
        });
    }
    let global = dirs.global.join(format!("{name}.yaml"));
    if global.exists() {
        return Some(Resolved {
            file: global.to_string_lossy().into_owned(),
            source: Source::Global,
        });
    }
    None
}

/// `collectWorkflowEntries`: every workflow name in both scopes, repo
/// shadowing global, sorted by name. Entries are unvalidated (no `inputs`,
/// `error`, etc.) — `load::list_workflows` fills those in.
#[must_use]
pub fn collect_workflow_entries(dirs: &WorkflowDirs) -> Vec<WorkflowListEntry> {
    let mut by_name = std::collections::BTreeMap::new();
    for (dir, source) in [
        (dirs.global.clone(), Source::Global),
        (dirs.repo_workflows(), Source::Repo),
    ] {
        for name in yaml_names(&dir) {
            let file = dir
                .join(format!("{name}.yaml"))
                .to_string_lossy()
                .into_owned();
            by_name.insert(name.clone(), WorkflowListEntry::new(name, source, file));
        }
    }
    by_name.into_values().collect()
}
