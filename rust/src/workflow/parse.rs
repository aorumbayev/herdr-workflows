//! YAML → `RawWorkflow` with Zod-equivalent validation. Port of
//! `src/workflows/parse.ts` (`Bun.YAML.parse` + `rawWorkflowSchema.safeParse`).
//!
//! serde cannot reproduce Zod's messages, so this validates the
//! `serde_yml::Value` tree by hand and constructs `types::RawWorkflow`
//! directly. Behaviors pinned empirically against the TS loader (Zod v4):
//! - Issues collect in schema-field order (not document order); unrecognized
//!   keys are reported last, per object, in document order.
//! - `invalid_type` / `invalid_value` / `unrecognized_keys` issues "abort" a
//!   step object: its `superRefine` pass (refine.rs) is skipped. `too_small` /
//!   `too_big` do not abort.
//! - The `options` union surfaces the branch whose type matched; when no
//!   branch's type matches, Zod emits a bare `Invalid input`.
//! - Multi-document YAML parses to an array under `Bun.YAML.parse`, which Zod
//!   then rejects as a non-object.

use std::collections::{BTreeMap, HashSet};

use serde_yml::{Mapping, Value};

use super::errors::{WorkflowLoadError, positioned};
use super::placeholder::is_input_name;
use super::refine::refine_step_verbs;
use super::types::{RawInput, RawOptions, RawStep, RawWorkflow, WaitDone};

const STEP_KEYS: [&str; 12] = [
    "shell",
    "open",
    "agent",
    "herdr",
    "run",
    "stdin",
    "prompt",
    "params",
    "wait",
    "wait_for",
    "timeout",
    "close_source",
];

const INPUT_KEYS: [&str; 3] = ["label", "options", "default"];

const WORKFLOW_KEYS: [&str; 3] = ["inputs", "steps", "on_fail"];

/// Exclusive safe-integer bound from Zod's `.int()` format check.
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

struct Issues<'a> {
    file: &'a str,
    list: Vec<String>,
}

impl Issues<'_> {
    fn push(&mut self, step: Option<usize>, key: Option<&str>, message: String) {
        self.list.push(positioned(self.file, step, key, &message));
    }

    fn finish<T>(self, value: T) -> Result<T, WorkflowLoadError> {
        if self.list.is_empty() {
            Ok(value)
        } else {
            Err(WorkflowLoadError(self.list.join("; ")))
        }
    }
}

/// Zod v4 `parsedType` names for YAML value kinds.
fn zod_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Sequence(_) => "array",
        Value::Mapping(_) => "object",
        Value::Tagged(tagged) => zod_type(&tagged.value),
    }
}

fn invalid_input(expected: &str, value: &Value) -> String {
    format!(
        "Invalid input: expected {expected}, received {}",
        zod_type(value)
    )
}

fn unrecognized(keys: &[String]) -> String {
    let quoted: Vec<String> = keys.iter().map(|k| format!("\"{k}\"")).collect();
    if keys.len() == 1 {
        format!("Unrecognized key: {}", quoted[0])
    } else {
        format!("Unrecognized keys: {}", quoted.join(", "))
    }
}

/// JS object-key stringification for non-string YAML keys (`{1: x}` → key `"1"`).
fn js_key(key: &Value) -> Option<String> {
    match key {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some("null".to_string()),
        Value::Number(n) => n
            .as_i64()
            .map(|i| i.to_string())
            .or_else(|| n.as_u64().map(|u| u.to_string()))
            .or_else(|| n.as_f64().map(|f| format!("{f}"))),
        Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_) => None,
    }
}

fn mapping_get<'a>(map: &'a Mapping, key: &str) -> Option<&'a Value> {
    map.iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

fn unknown_keys(map: &Mapping, known: &[&str]) -> Vec<String> {
    map.keys()
        .filter_map(js_key)
        .filter(|k| !known.contains(&k.as_str()))
        .collect()
}

/// `serde_yml` scan/parse error → Bun.YAML's four-message vocabulary. Only
/// "Unexpected EOF" is pinned by the golden corpus; the rest are best-effort
/// matches of Bun's `YAML Parse error: <detail>` phrasing.
fn map_yaml_error(message: &str) -> String {
    let detail = if message.contains("end of stream") || message.contains("end of file") {
        "Unexpected EOF"
    } else if message.contains("unknown anchor") {
        "Unresolved alias"
    } else if message.contains("scanning an anchor") || message.contains("found character") {
        "Unexpected character"
    } else {
        "Unexpected token"
    };
    format!("YAML Parse error: {detail}")
}

/// Validate `text` as a raw workflow document. Port of `parseRaw`.
///
/// # Errors
/// `WorkflowLoadError` with the Zod-style issues joined by `"; "`, or the
/// mapped YAML parse error — both positioned with `file` as the label.
pub fn parse_raw(file: &str, text: &str) -> Result<RawWorkflow, WorkflowLoadError> {
    let value: Value = match serde_yml::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            let message = e.to_string();
            if message.contains("more than one document") {
                // Bun.YAML.parse returns an array of documents for multi-doc input.
                return Err(WorkflowLoadError(positioned(
                    file,
                    None,
                    None,
                    "Invalid input: expected object, received array",
                )));
            }
            return Err(WorkflowLoadError(positioned(
                file,
                None,
                None,
                &map_yaml_error(&message),
            )));
        }
    };
    let mut issues = Issues {
        file,
        list: Vec::new(),
    };
    let Value::Mapping(map) = &value else {
        issues.push(
            None,
            None,
            format!(
                "Invalid input: expected object, received {}",
                zod_type(&value)
            ),
        );
        return issues.finish(RawWorkflow {
            inputs: None,
            input_order: Vec::new(),
            steps: Vec::new(),
            on_fail: None,
        });
    };

    // Schema field order: inputs, steps, on_fail.
    let (inputs, input_order) = match mapping_get(map, "inputs") {
        Some(v) => validate_inputs(v, &mut issues),
        None => (None, Vec::new()),
    };
    let steps = match mapping_get(map, "steps") {
        Some(v) => validate_steps(v, &mut issues),
        None => {
            issues.push(
                None,
                Some("steps"),
                "Invalid input: expected array, received undefined".to_string(),
            );
            Vec::new()
        }
    };
    let on_fail = mapping_get(map, "on_fail")
        .and_then(|v| string_field(&mut issues, None, "on_fail", v, true).0);

    let unknown = unknown_keys(map, &WORKFLOW_KEYS);
    if !unknown.is_empty() {
        let joined = unknown.join(", ");
        issues.push(None, Some(&joined), unrecognized(&unknown));
    }

    issues.finish(RawWorkflow {
        inputs,
        input_order,
        steps,
        on_fail,
    })
}

/// Optional string field; `min1` reproduces `z.string().min(1)`. Returns the
/// value plus whether the failure aborts the enclosing object (`invalid_type`
/// does, `too_small` does not).
fn string_field(
    issues: &mut Issues,
    step: Option<usize>,
    key: &str,
    value: &Value,
    min1: bool,
) -> (Option<String>, bool) {
    let Some(s) = value.as_str() else {
        issues.push(step, Some(key), invalid_input("string", value));
        return (None, true);
    };
    if min1 && s.is_empty() {
        issues.push(
            step,
            Some(key),
            "Too small: expected string to have >=1 characters".to_string(),
        );
        return (None, false);
    }
    (Some(s.to_string()), false)
}

fn validate_steps(value: &Value, issues: &mut Issues) -> Vec<RawStep> {
    let Value::Sequence(items) = value else {
        issues.push(None, Some("steps"), invalid_input("array", value));
        return Vec::new();
    };
    if items.is_empty() {
        issues.push(
            None,
            Some("steps"),
            "Too small: expected array to have >=1 items".to_string(),
        );
        return Vec::new();
    }
    items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| validate_step(i + 1, item, issues))
        .collect()
}

fn validate_step(n: usize, value: &Value, issues: &mut Issues) -> Option<RawStep> {
    let Value::Mapping(map) = value else {
        issues.push(Some(n), None, invalid_input("object", value));
        return None;
    };
    let before = issues.list.len();
    let mut aborted = false;
    let mut step = RawStep::default();

    // Schema field order, not document order.
    for key in &STEP_KEYS[..7] {
        if let Some(v) = mapping_get(map, key) {
            let (parsed, abort) = string_field(issues, Some(n), key, v, false);
            aborted |= abort;
            match *key {
                "shell" => step.shell = parsed,
                "open" => step.open = parsed,
                "agent" => step.agent = parsed,
                "herdr" => step.herdr = parsed,
                "run" => step.run = parsed,
                "stdin" => step.stdin = parsed,
                _ => step.prompt = parsed,
            }
        }
    }

    if let Some(v) = mapping_get(map, "params") {
        if let Value::Mapping(params) = v {
            step.params = Some(yaml_mapping_to_json(params));
        } else {
            issues.push(Some(n), Some("params"), invalid_input("record", v));
            aborted = true;
        }
    }

    if let Some(v) = mapping_get(map, "wait") {
        if v.as_str() == Some("done") {
            step.wait = Some(WaitDone::Done);
        } else {
            issues.push(
                Some(n),
                Some("wait"),
                "Invalid input: expected \"done\"".to_string(),
            );
            aborted = true;
        }
    }

    if let Some(v) = mapping_get(map, "wait_for") {
        let (parsed, abort) = string_field(issues, Some(n), "wait_for", v, true);
        aborted |= abort;
        step.wait_for = parsed;
    }

    if let Some(v) = mapping_get(map, "timeout") {
        let (parsed, abort) = validate_timeout(issues, n, v);
        aborted |= abort;
        step.timeout = parsed;
    }

    if let Some(v) = mapping_get(map, "close_source") {
        if let Some(b) = v.as_bool() {
            step.close_source = Some(b);
        } else {
            issues.push(Some(n), Some("close_source"), invalid_input("boolean", v));
            aborted = true;
        }
    }

    let unknown = unknown_keys(map, &STEP_KEYS);
    if !unknown.is_empty() {
        issues.push(Some(n), None, unrecognized(&unknown));
        aborted = true;
    }

    if !aborted {
        let present: HashSet<&str> = map.keys().filter_map(|k| k.as_str()).collect();
        for issue in refine_step_verbs(&present) {
            issues.push(Some(n), issue.key, issue.message);
        }
    }

    (issues.list.len() == before).then_some(step)
}

/// `z.number().int().positive()` over a YAML number, in f64 like JS.
/// Returns the value plus whether the failure aborts the step.
fn validate_timeout(issues: &mut Issues, n: usize, value: &Value) -> (Option<u64>, bool) {
    let Value::Number(number) = value else {
        issues.push(Some(n), Some("timeout"), invalid_input("number", value));
        return (None, true);
    };
    let Some(f) = number.as_f64() else {
        issues.push(Some(n), Some("timeout"), invalid_input("number", value));
        return (None, true);
    };
    if !f.is_finite() || f.fract() != 0.0 {
        issues.push(
            Some(n),
            Some("timeout"),
            "Invalid input: expected int, received number".to_string(),
        );
        return (None, true);
    }
    // Non-aborting range/sign checks; Zod keeps collecting.
    if f >= MAX_SAFE_INT {
        issues.push(
            Some(n),
            Some("timeout"),
            "Too big: expected int to be <9007199254740991".to_string(),
        );
    } else if f <= -MAX_SAFE_INT {
        issues.push(
            Some(n),
            Some("timeout"),
            "Too small: expected int to be >-9007199254740991".to_string(),
        );
    }
    if f <= 0.0 {
        issues.push(
            Some(n),
            Some("timeout"),
            "Too small: expected number to be >0".to_string(),
        );
    }
    #[expect(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let parsed = (f > 0.0 && f < MAX_SAFE_INT).then_some(f as u64);
    (parsed, false)
}

fn validate_inputs(
    value: &Value,
    issues: &mut Issues,
) -> (Option<BTreeMap<String, RawInput>>, Vec<String>) {
    let Value::Mapping(map) = value else {
        issues.push(None, Some("inputs"), invalid_input("record", value));
        return (None, Vec::new());
    };
    let mut inputs = BTreeMap::new();
    let mut order = Vec::with_capacity(map.len());
    for (key, v) in map {
        match js_key(key) {
            Some(name) if is_input_name(&name) => {
                if let Some(input) = validate_input(v, issues) {
                    if inputs.insert(name.clone(), input).is_none() {
                        order.push(name);
                    }
                }
            }
            _ => issues.push(None, Some("inputs"), "Invalid key in record".to_string()),
        }
    }
    (Some(inputs), order)
}

fn validate_input(value: &Value, issues: &mut Issues) -> Option<RawInput> {
    let Value::Mapping(map) = value else {
        issues.push(None, Some("inputs"), invalid_input("object", value));
        return None;
    };
    let before = issues.list.len();
    let mut input = RawInput::default();

    if let Some(v) = mapping_get(map, "label") {
        input.label = string_field(issues, None, "inputs", v, true).0;
    }
    if let Some(v) = mapping_get(map, "options") {
        input.options = validate_options(v, issues);
    }
    if let Some(v) = mapping_get(map, "default") {
        input.default = string_field(issues, None, "inputs", v, false).0;
    }

    let unknown = unknown_keys(map, &INPUT_KEYS);
    if !unknown.is_empty() {
        issues.push(None, Some("inputs"), unrecognized(&unknown));
    }

    (issues.list.len() == before).then_some(input)
}

/// `z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])`. Zod
/// surfaces the branch whose type matched; when neither branch type-matches
/// (non-string/array, or a non-string array item) the union error is a bare
/// `Invalid input`.
fn validate_options(value: &Value, issues: &mut Issues) -> Option<RawOptions> {
    match value {
        Value::String(s) => {
            if s.is_empty() {
                issues.push(
                    None,
                    Some("inputs"),
                    "Too small: expected string to have >=1 characters".to_string(),
                );
                None
            } else {
                Some(RawOptions::Command(s.clone()))
            }
        }
        Value::Sequence(items) => {
            if items.is_empty() {
                issues.push(
                    None,
                    Some("inputs"),
                    "Too small: expected array to have >=1 items".to_string(),
                );
                return None;
            }
            if items.iter().any(|item| !item.is_string()) {
                issues.push(None, Some("inputs"), "Invalid input".to_string());
                return None;
            }
            let mut choices = Vec::with_capacity(items.len());
            for item in items {
                let Some(s) = item.as_str() else {
                    continue;
                };
                if s.is_empty() {
                    issues.push(
                        None,
                        Some("inputs"),
                        "Too small: expected string to have >=1 characters".to_string(),
                    );
                } else {
                    choices.push(s.to_string());
                }
            }
            (choices.len() == items.len()).then_some(RawOptions::Choices(choices))
        }
        _ => {
            issues.push(None, Some("inputs"), "Invalid input".to_string());
            None
        }
    }
}

/// YAML → JSON for `params` values; mapping keys are stringified JS-style.
fn yaml_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::Value::Bool(*b),
        Value::Number(n) => n
            .as_i64()
            .map(serde_json::Value::from)
            .or_else(|| n.as_u64().map(serde_json::Value::from))
            .or_else(|| {
                n.as_f64()
                    .and_then(serde_json::Number::from_f64)
                    .map(serde_json::Value::Number)
            })
            .unwrap_or(serde_json::Value::Null),
        Value::String(s) => serde_json::Value::String(s.clone()),
        Value::Sequence(items) => {
            serde_json::Value::Array(items.iter().map(yaml_to_json).collect())
        }
        Value::Mapping(map) => {
            serde_json::Value::Object(yaml_mapping_to_json(map).into_iter().collect())
        }
        Value::Tagged(tagged) => yaml_to_json(&tagged.value),
    }
}

fn yaml_mapping_to_json(map: &Mapping) -> BTreeMap<String, serde_json::Value> {
    map.iter()
        .filter_map(|(k, v)| js_key(k).map(|k| (k, yaml_to_json(v))))
        .collect()
}
