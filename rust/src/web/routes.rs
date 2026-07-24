//! JSON route handlers. Port of `src/web/routes.ts`.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::config::load_config;
use crate::workflow::discover::{WorkflowDirs, workflow_path};
use crate::workflow::errors::Source;
use crate::workflow::load::{list_workflows, parse_workflow_text};
use crate::workflow::parse::parse_raw;
use crate::workflow::types::{RawInput, RawOptions, RawStep, RawWorkflow, WaitDone};

use super::yaml_build::dump_workflow;
use crate::runner::runlog::{RunLog, recent_runs};

/// A JSON response body plus its HTTP status — TS `json(body, status)`.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonResponse {
    pub status: u16,
    pub body: Value,
}

impl JsonResponse {
    /// Status-200 JSON.
    #[must_use]
    pub fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    /// `{ok: false, error}` with the given status — the shared failure shape.
    #[must_use]
    pub fn err(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({"ok": false, "error": message.into()}),
        }
    }
}

/// Routes that can also answer with plain text (`method not allowed`).
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Json(JsonResponse),
    Text { status: u16, body: &'static str },
}

impl From<JsonResponse> for Outcome {
    fn from(response: JsonResponse) -> Self {
        Self::Json(response)
    }
}

/// JS `String(v ?? "")` coercion for JSON request bodies: strings pass
/// through, numbers/bools stringify, null/missing/objects become `""`.
#[must_use]
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// `"repo" | "global"` query/body value — anything else is absent (TS `scopeOf`).
#[must_use]
pub fn scope_of(v: Option<&Value>) -> Option<Source> {
    match v {
        Some(Value::String(s)) if s == "repo" => Some(Source::Repo),
        Some(Value::String(s)) if s == "global" => Some(Source::Global),
        _ => None,
    }
}

/// `"repo"` / `"global"` for a [`Source`].
#[must_use]
pub fn source_name(source: Source) -> &'static str {
    match source {
        Source::Repo => "repo",
        Source::Global => "global",
    }
}

/// Home-relative path for display (`~/…`). Port of `shortPath` in `server.ts`.
#[must_use]
pub fn short_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::home_dir().map(Into::into))
    else {
        return raw.into_owned();
    };
    let home = home.to_string_lossy();
    if raw == home {
        return "~".to_string();
    }
    if let Some(rest) = raw.strip_prefix(format!("{home}/").as_str()) {
        return format!("~/{rest}");
    }
    raw.into_owned()
}

/// Agents configured for `dirs.repo_root`, as the set the loader wants.
pub fn agents_of(repo_root: &Path) -> Result<HashSet<String>, String> {
    load_config(repo_root)
        .map(|cfg| cfg.agents.keys().cloned().collect())
        .map_err(|e| e.to_string())
}

/// `GET /api/state` — `getState`.
///
/// # Errors
/// Config load failures surface as the TS 500 catch-all body.
pub fn get_state(dirs: &WorkflowDirs) -> Result<JsonResponse, String> {
    let cfg = load_config(&dirs.repo_root).map_err(|e| e.to_string())?;
    let agents: Vec<&String> = cfg.agents.keys().collect();
    let agent_set: HashSet<String> = cfg.agents.keys().cloned().collect();
    let entries = list_workflows(dirs, &agent_set);
    let mapped: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "name": e.name,
                "source": source_name(e.source),
                "valid": e.error.is_none(),
                "inRepo": workflow_path(Source::Repo, dirs, &e.name).exists(),
                "inGlobal": workflow_path(Source::Global, dirs, &e.name).exists(),
            })
        })
        .collect();
    Ok(JsonResponse::ok(json!({
        "repoRoot": short_path(&dirs.repo_root),
        "agents": agents,
        "entries": mapped,
    })))
}

/// `POST /api/parse` — `handleParse`. The returned `doc` mirrors the TS Zod
/// output: only keys present in the source YAML appear.
#[must_use]
pub fn handle_parse(body: &Value) -> JsonResponse {
    let text = js_string(body.get("text"));
    match parse_raw("buffer.yaml", &text) {
        Ok(doc) => JsonResponse::ok(json!({"ok": true, "doc": workflow_to_json(&doc)})),
        Err(e) => JsonResponse::err(400, e.to_string()),
    }
}

/// `POST /api/format` — `handleFormat`: dump the posted doc, re-parse it for
/// validation, then dump the parsed document.
#[must_use]
pub fn handle_format(body: &Value) -> JsonResponse {
    let result = body
        .get("doc")
        .ok_or_else(|| "doc required".to_string())
        .and_then(workflow_from_json)
        .map(|doc| dump_workflow(&doc))
        .and_then(|text| {
            parse_raw("buffer.yaml", &text)
                .map(|parsed| dump_workflow(&parsed))
                .map_err(|e| e.to_string())
        });
    match result {
        Ok(text) => JsonResponse::ok(json!({"ok": true, "text": text})),
        Err(e) => JsonResponse::err(400, e),
    }
}

/// `POST /api/validate` — `handleValidate`. Runs the exact CLI load path
/// (`parse_workflow_text`) so error strings match byte-for-byte.
///
/// # Errors
/// Config load failures surface as the TS 500 catch-all body.
pub fn handle_validate(dirs: &WorkflowDirs, body: &Value) -> Result<JsonResponse, String> {
    let name = match body.get("name") {
        None | Some(Value::Null) => "buffer".to_string(),
        v => js_string(v),
    };
    let agents = agents_of(&dirs.repo_root)?;
    let text = js_string(body.get("text"));
    match parse_workflow_text(&name, &text, &agents, dirs, &format!("{name}.yaml"), true) {
        Ok(_) => Ok(JsonResponse::ok(json!({"ok": true}))),
        Err(e) => Ok(JsonResponse::err(400, e.to_string())),
    }
}

/// `GET /api/runs` — `handleRuns`. The log lives in `runner::runlog`
/// (runner owns the writer; web only reads via `RunLog::from_env`).
#[must_use]
pub fn handle_runs() -> JsonResponse {
    JsonResponse::ok(json!({"runs": recent_runs(&RunLog::from_env().read(), 40)}))
}

fn put_opt(map: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(v) = value {
        map.insert(key.to_string(), Value::String(v.clone()));
    }
}

fn step_to_json(step: &RawStep) -> Value {
    let mut m = Map::new();
    put_opt(&mut m, "shell", &step.shell);
    put_opt(&mut m, "open", &step.open);
    put_opt(&mut m, "agent", &step.agent);
    put_opt(&mut m, "herdr", &step.herdr);
    put_opt(&mut m, "run", &step.run);
    put_opt(&mut m, "stdin", &step.stdin);
    put_opt(&mut m, "prompt", &step.prompt);
    if let Some(params) = &step.params {
        m.insert("params".to_string(), json!(params));
    }
    if step.wait == Some(WaitDone::Done) {
        m.insert("wait".to_string(), json!("done"));
    }
    put_opt(&mut m, "wait_for", &step.wait_for);
    if let Some(timeout) = step.timeout {
        m.insert("timeout".to_string(), json!(timeout));
    }
    if let Some(close_source) = step.close_source {
        m.insert("close_source".to_string(), json!(close_source));
    }
    Value::Object(m)
}

fn workflow_to_json(doc: &RawWorkflow) -> Value {
    let mut m = Map::new();
    if let Some(inputs) = &doc.inputs {
        let obj: Map<String, Value> = inputs
            .iter()
            .map(|(name, inp)| {
                let mut im = Map::new();
                put_opt(&mut im, "label", &inp.label);
                if let Some(options) = &inp.options {
                    let value = match options {
                        RawOptions::Command(command) => json!(command),
                        RawOptions::Choices(choices) => json!(choices),
                    };
                    im.insert("options".to_string(), value);
                }
                put_opt(&mut im, "default", &inp.default);
                (name.clone(), Value::Object(im))
            })
            .collect();
        m.insert("inputs".to_string(), Value::Object(obj));
    }
    m.insert(
        "steps".to_string(),
        doc.steps.iter().map(step_to_json).collect(),
    );
    put_opt(&mut m, "on_fail", &doc.on_fail);
    Value::Object(m)
}

/// Lenient JSON scalar read for `dump_workflow` inputs (TS duck-typing:
/// present non-string scalars coerce, null/missing are absent).
fn opt_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn step_from_json(v: &Value) -> RawStep {
    let get = |k: &str| opt_str(v.get(k));
    let wait = if v.get("wait").and_then(Value::as_str) == Some("done") {
        Some(WaitDone::Done)
    } else {
        None
    };
    let params = v.get("params").and_then(Value::as_object).map(|obj| {
        obj.iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect()
    });
    RawStep {
        shell: get("shell"),
        open: get("open"),
        agent: get("agent"),
        herdr: get("herdr"),
        run: get("run"),
        stdin: get("stdin"),
        prompt: get("prompt"),
        params,
        wait,
        wait_for: get("wait_for"),
        timeout: v.get("timeout").and_then(Value::as_u64),
        close_source: v.get("close_source").and_then(Value::as_bool),
    }
}

fn workflow_from_json(v: &Value) -> Result<RawWorkflow, String> {
    let steps = v
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "doc.steps must be an array".to_string())?
        .iter()
        .map(step_from_json)
        .collect();
    let inputs = v.get("inputs").and_then(Value::as_object).map(|obj| {
        obj.iter()
            .map(|(name, iv)| {
                let options = match iv.get("options") {
                    Some(Value::String(s)) => Some(RawOptions::Command(s.clone())),
                    Some(Value::Array(items)) => Some(RawOptions::Choices(
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect(),
                    )),
                    _ => None,
                };
                let input = RawInput {
                    label: opt_str(iv.get("label")),
                    options,
                    default: opt_str(iv.get("default")),
                };
                (name.clone(), input)
            })
            .collect()
    });
    Ok(RawWorkflow {
        inputs,
        input_order: Vec::new(),
        steps,
        on_fail: opt_str(v.get("on_fail")),
    })
}
