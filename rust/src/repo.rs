//! Repo-root discovery. Port of `src/repo.ts`.

use std::path::{Path, PathBuf};

/// `resolveRepoRoot(start)`: walk up from `start` looking for `.git` or
/// `.hwf`; fall back to `start` at the filesystem root.
#[must_use]
pub fn resolve_repo_root(start: &Path) -> PathBuf {
    let mut dir = start;
    loop {
        if dir.join(".git").exists() || dir.join(".hwf").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return start.to_path_buf(),
        }
    }
}

/// `resolveRepoRoot()` default — start at the process cwd.
#[must_use]
pub fn resolve_repo_root_from_cwd() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_repo_root(&cwd)
}
