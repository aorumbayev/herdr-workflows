//! `WorkflowLoadError` and positioned error strings. Port of `src/workflows/errors.ts`.

use std::fmt::Write as _;

use thiserror::Error;

/// Load/validation failure whose message is the full positioned error string
/// (`file[, step N][, key]: message`), byte-identical to the TS loader's output.
#[derive(Debug, Error)]
#[error("{0}")]
pub struct WorkflowLoadError(pub String);

/// Where a workflow file came from (`"repo" | "global"` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    Repo,
    Global,
}

/// Resolved input — `InputSpec` in `src/workflows/errors.ts`. `options` present
/// means a choice input; absent means free text (resolved lines, never a shell
/// command string).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputSpec {
    pub name: String,
    pub label: String,
    pub options: Option<Vec<String>>,
    /// Dynamic choices exist but were intentionally not executed during listing.
    pub dynamic_options: bool,
    pub default: Option<String>,
}

/// Picker/listing row — `WorkflowListEntry` in `src/workflows/errors.ts`. The
/// `Option` fields stay `None` until `list_workflows` validates the entry;
/// `error` is set instead when validation fails (the picker dims those rows).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowListEntry {
    pub name: String,
    pub source: Source,
    pub file: String,
    pub error: Option<String>,
    pub needs_prompt: Option<bool>,
    pub inputs: Option<Vec<InputSpec>>,
    pub repo_owned: Option<bool>,
    pub dynamic_options: Option<bool>,
}

impl WorkflowListEntry {
    /// A fresh entry from directory scanning, before validation.
    #[must_use]
    pub fn new(name: String, source: Source, file: String) -> Self {
        Self {
            name,
            source,
            file,
            error: None,
            needs_prompt: None,
            inputs: None,
            repo_owned: None,
            dynamic_options: None,
        }
    }
}

/// `file, step N, key: message` — omitted segments are skipped. Port of `positioned()`.
pub fn positioned(file: &str, step: Option<usize>, key: Option<&str>, message: &str) -> String {
    let mut out = String::from(file);
    if let Some(step) = step {
        write!(out, ", step {step}").expect("write to String cannot fail");
    }
    if let Some(key) = key {
        write!(out, ", {key}").expect("write to String cannot fail");
    }
    write!(out, ": {message}").expect("write to String cannot fail");
    out
}
