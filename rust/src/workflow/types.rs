//! Raw workflow AST mirroring the Zod schemas in `src/workflows/parse.ts`.
//!
//! The serde derives reproduce the strict-object schema shape (and feed schemars
//! for `docs/workflow.schema.json` regen in P4), but the load path does not use
//! them: Zod's exact error strings are not expressible through serde, so
//! `parse::parse_raw` validates the `serde_yml::Value` tree by hand and
//! constructs these types directly (design.md D4).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::Deserialize;

/// One step's raw fields — all twelve keys of `rawStepSchema`, strict object.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RawStep {
    pub shell: Option<String>,
    pub open: Option<String>,
    pub agent: Option<String>,
    pub herdr: Option<String>,
    pub run: Option<String>,
    pub stdin: Option<String>,
    pub prompt: Option<String>,
    pub params: Option<BTreeMap<String, serde_json::Value>>,
    pub wait: Option<WaitDone>,
    pub wait_for: Option<String>,
    /// `z.number().int().positive()` — seconds; validated before construction.
    pub timeout: Option<u64>,
    pub close_source: Option<bool>,
}

/// The `wait: done` literal (`z.literal("done")`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WaitDone {
    Done,
}

/// `options:` union — a shell command producing choice lines, or an inline list
/// (`z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RawOptions {
    Command(String),
    Choices(Vec<String>),
}

/// One declared input — `rawInputSchema`, strict object.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RawInput {
    pub label: Option<String>,
    pub options: Option<RawOptions>,
    pub default: Option<String>,
}

/// The workflow document — `rawWorkflowSchema`, strict object.
///
/// `inputs` is a `BTreeMap` (sorted) for schema/serde shape, but the TS record
/// preserves declaration order and that order is observable (input listing,
/// first-unused-input error), so `parse_raw` also records it in `input_order`.
#[derive(Debug, Clone, PartialEq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RawWorkflow {
    pub inputs: Option<BTreeMap<String, RawInput>>,
    /// Declaration order of `inputs` keys; derived by `parse_raw`, not YAML data.
    #[serde(skip)]
    #[schemars(skip)]
    pub input_order: Vec<String>,
    pub steps: Vec<RawStep>,
    pub on_fail: Option<String>,
}
