//! Entry-text loader: parse → refine → `rawToFlat` → `checkAgents`. This is
//! `loadFromRaw` in `src/workflows/load.ts` minus flatten/inputs/recovery,
//! which task 1.5 builds on top of these pieces.

use std::collections::HashSet;

use super::errors::WorkflowLoadError;
use super::parse::parse_raw;
use super::steps::{FlatStep, check_agents, raw_to_flat};
use super::types::RawWorkflow;

/// A validated workflow buffer. `raw` keeps the parsed document for the
/// flatten/inputs/recovery passes (task 1.5); `steps` are the flat steps.
#[derive(Debug)]
pub struct ParsedEntry {
    pub raw: RawWorkflow,
    pub steps: Vec<FlatStep>,
}

/// Validate an in-memory YAML buffer with the entry file's label (`file`).
/// `run` steps are skipped, not spliced: run-target resolution is flatten's
/// job (task 1.5), and every `run` step reaching `rawToFlat` unflattened is an
/// internal error there.
///
/// # Errors
/// `WorkflowLoadError` with the positioned error string, byte-identical to the
/// TS loader for parse/refine/steps failures.
pub fn parse_entry(
    file: &str,
    text: &str,
    agents: &HashSet<String>,
) -> Result<ParsedEntry, WorkflowLoadError> {
    let raw = parse_raw(file, text)?;
    let mut steps = Vec::with_capacity(raw.steps.len());
    for (i, step) in raw.steps.iter().enumerate() {
        if step.run.is_some() {
            continue;
        }
        steps.push(raw_to_flat(file, i + 1, step)?);
    }
    check_agents(file, &steps, agents)?;
    Ok(ParsedEntry { raw, steps })
}
