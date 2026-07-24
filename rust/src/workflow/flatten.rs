//! `run:` step splicing with cycle detection. Port of `src/workflows/flatten.ts`.

use std::collections::HashSet;

use super::discover::{Resolved, WorkflowDirs, resolve_workflow_file};
use super::errors::{Source, WorkflowLoadError, positioned};
use super::parse::parse_raw;
use super::steps::{FlatStep, raw_to_flat};
use super::types::RawWorkflow;

/// A workflow file parsed from disk — `parseFile`'s return shape.
#[derive(Debug)]
pub struct ParsedFile {
    pub file: String,
    pub raw: RawWorkflow,
}

/// `parseFile`: read + `parse_raw`, labeled with the path itself (so spliced
/// files produce absolute-path error labels, matching the TS loader).
///
/// # Errors
/// `WorkflowLoadError` when the file is missing, unreadable, or invalid.
pub fn parse_file(file: &str) -> Result<ParsedFile, WorkflowLoadError> {
    if !std::path::Path::new(file).exists() {
        return Err(WorkflowLoadError(positioned(
            file,
            None,
            None,
            "file not found",
        )));
    }
    let text = std::fs::read_to_string(file)
        .map_err(|e| WorkflowLoadError(positioned(file, None, None, &e.to_string())))?;
    Ok(ParsedFile {
        file: file.to_string(),
        raw: parse_raw(file, &text)?,
    })
}

/// `flattenSteps`: splice `run:` targets in place, depth-first. `stack` holds
/// the ancestor chain (empty for the entry workflow); `root`/`root_raw` supply
/// the already-parsed entry so its buffer label (not an absolute path) is used
/// for its own steps. `sources` accumulates the scopes that contributed steps.
///
/// # Errors
/// `WorkflowLoadError` on cycles, unknown targets, spliced workflows declaring
/// inputs, or any parse/step error in a spliced file.
pub fn flatten_steps(
    name: &str,
    dirs: &WorkflowDirs,
    stack: &[String],
    mut sources: Option<&mut HashSet<Source>>,
    root: Option<(&str, Source)>,
    root_raw: Option<&RawWorkflow>,
) -> Result<Vec<FlatStep>, WorkflowLoadError> {
    if stack.iter().any(|n| n == name) {
        let chain = stack
            .iter()
            .cloned()
            .chain([name.to_string()])
            .collect::<Vec<_>>()
            .join(" → ");
        return Err(WorkflowLoadError(positioned(
            &format!("{name}.yaml"),
            None,
            Some("run"),
            &format!("cycle detected: {chain}"),
        )));
    }
    let resolved = match (stack.is_empty(), root) {
        (true, Some((file, source))) => Resolved {
            file: file.to_string(),
            source,
        },
        _ => {
            let Some(resolved) = resolve_workflow_file(name, dirs) else {
                let from = stack.last().map_or(name, String::as_str);
                return Err(WorkflowLoadError(positioned(
                    &format!("{from}.yaml"),
                    None,
                    Some("run"),
                    &format!("unknown workflow '{name}'"),
                )));
            };
            resolved
        }
    };
    if let Some(sources) = sources.as_deref_mut() {
        sources.insert(resolved.source);
    }
    let parsed = match (stack.is_empty(), root_raw) {
        (true, Some(raw)) => ParsedFile {
            file: resolved.file.clone(),
            raw: raw.clone(),
        },
        _ => parse_file(&resolved.file)?,
    };
    if !stack.is_empty() && parsed.raw.inputs.is_some() {
        let from = stack.last().map_or(name, String::as_str);
        return Err(WorkflowLoadError(positioned(
            &format!("{from}.yaml"),
            None,
            Some("run"),
            &format!(
                "spliced workflow '{name}' declares inputs — declare them on the entry workflow"
            ),
        )));
    }
    let mut next = Vec::with_capacity(stack.len() + 1);
    next.extend_from_slice(stack);
    next.push(name.to_string());
    let mut out = Vec::with_capacity(parsed.raw.steps.len());
    for (i, step) in parsed.raw.steps.iter().enumerate() {
        if let Some(run) = &step.run {
            out.extend(flatten_steps(
                run,
                dirs,
                &next,
                sources.as_deref_mut(),
                None,
                None,
            )?);
        } else {
            out.push(raw_to_flat(&resolved.file, i + 1, step)?);
        }
    }
    Ok(out)
}
