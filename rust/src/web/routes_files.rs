//! File-backed route handlers (`/api/workflow`, `/api/promote`,
//! `/api/config`). Port of `src/web/routes-files.ts`.

use serde_json::{Map, Value, json};
use tiny_http::Method;

use crate::config::{global_config_path, parse_config_text, repo_config_path};
use crate::workflow::discover::{WorkflowDirs, workflow_path};
use crate::workflow::errors::Source;
use crate::workflow::load::parse_workflow_text;

use super::routes::{JsonResponse, Outcome, agents_of, js_string, scope_of, source_name};

/// `/^[a-z0-9][a-z0-9-_]*$/` — rejects path traversal and empty names.
#[must_use]
pub fn valid_workflow_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn write_workflow(
    dirs: &WorkflowDirs,
    name: &str,
    scope: Source,
    text: &str,
) -> Result<Outcome, String> {
    if !valid_workflow_name(name) {
        return Ok(JsonResponse::err(400, "invalid workflow name").into());
    }
    let agents = agents_of(&dirs.repo_root)?;
    if let Err(e) = parse_workflow_text(name, text, &agents, dirs, &format!("{name}.yaml"), true) {
        return Ok(JsonResponse::err(400, e.to_string()).into());
    }
    let file = workflow_path(scope, dirs, name);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(JsonResponse::ok(json!({"ok": true})).into())
}

/// `/api/workflow` GET/PUT/DELETE — `handleWorkflow`.
///
/// # Errors
/// I/O and config failures surface as the TS 500 catch-all body.
pub fn handle_workflow(
    dirs: &WorkflowDirs,
    method: &Method,
    query: &str,
    body: &Value,
) -> Result<Outcome, String> {
    match *method {
        Method::Get => {
            let name = super::server::query_param(query, "name").unwrap_or_default();
            let scope = super::server::query_param(query, "scope")
                .and_then(|s| scope_of(Some(&Value::String(s))));
            if !valid_workflow_name(&name) || scope.is_none() {
                return Ok(JsonResponse {
                    status: 400,
                    body: json!({"error": "valid name and scope required"}),
                }
                .into());
            }
            let file = workflow_path(scope.expect("checked above"), dirs, &name);
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            let mut valid = true;
            let mut error: Option<String> = None;
            if !text.is_empty() {
                let agents = agents_of(&dirs.repo_root)?;
                if let Err(e) =
                    parse_workflow_text(&name, &text, &agents, dirs, &format!("{name}.yaml"), true)
                {
                    valid = false;
                    error = Some(e.to_string());
                }
            }
            let mut map = Map::new();
            map.insert("text".to_string(), json!(text));
            map.insert("valid".to_string(), json!(valid));
            if let Some(error) = error {
                map.insert("error".to_string(), json!(error));
            }
            Ok(JsonResponse::ok(Value::Object(map)).into())
        }
        Method::Put => {
            let Some(scope) = scope_of(body.get("scope")) else {
                return Ok(JsonResponse::err(400, "scope required").into());
            };
            let name = js_string(body.get("name"));
            let text = js_string(body.get("text"));
            write_workflow(dirs, &name, scope, &text)
        }
        Method::Delete => {
            let name = js_string(body.get("name"));
            let scope = scope_of(body.get("scope"));
            if !valid_workflow_name(&name) || scope.is_none() {
                return Ok(JsonResponse::err(400, "name and scope required").into());
            }
            let file = workflow_path(scope.expect("checked above"), dirs, &name);
            let _ = std::fs::remove_file(&file);
            Ok(JsonResponse::ok(json!({"ok": true})).into())
        }
        _ => Ok(Outcome::Text {
            status: 405,
            body: "method not allowed",
        }),
    }
}

/// `POST /api/promote` — `handlePromote`. 409 unless `force: true`.
///
/// # Errors
/// I/O failures surface as the TS 500 catch-all body.
pub fn handle_promote(dirs: &WorkflowDirs, body: &Value) -> Result<Outcome, String> {
    let name = js_string(body.get("name"));
    let from = scope_of(body.get("from"));
    let to = scope_of(body.get("to"));
    if !valid_workflow_name(&name) || from.is_none() || to.is_none() {
        return Ok(JsonResponse::err(400, "name, from, to required").into());
    }
    let src = workflow_path(from.expect("checked above"), dirs, &name);
    if !src.exists() {
        return Ok(JsonResponse::err(404, "source not found").into());
    }
    let to_scope = to.expect("checked above");
    let dst = workflow_path(to_scope, dirs, &name);
    if body.get("force") != Some(&Value::Bool(true)) && dst.exists() {
        return Ok(JsonResponse::err(
            409,
            format!("'{name}' already exists in {}", source_name(to_scope)),
        )
        .into());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(JsonResponse::ok(json!({"ok": true})).into())
}

/// `/api/config` GET/PUT — `handleConfig`.
///
/// # Errors
/// I/O failures surface as the TS 500 catch-all body.
pub fn handle_config(
    dirs: &WorkflowDirs,
    method: &Method,
    query: &str,
    body: &Value,
) -> Result<Outcome, String> {
    let scope = if *method == Method::Get {
        super::server::query_param(query, "scope").and_then(|s| scope_of(Some(&Value::String(s))))
    } else {
        scope_of(body.get("scope"))
    };
    let Some(scope) = scope else {
        return Ok(JsonResponse::err(400, "scope required").into());
    };
    let file = match scope {
        Source::Repo => repo_config_path(&dirs.repo_root),
        Source::Global => global_config_path(),
    };
    match *method {
        Method::Get => {
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            Ok(JsonResponse::ok(json!({"text": text})).into())
        }
        Method::Put => {
            let text = js_string(body.get("text"));
            if let Err(e) = parse_config_text(&file, &text) {
                return Ok(JsonResponse::err(400, e.to_string()).into());
            }
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&file, &text).map_err(|e| e.to_string())?;
            Ok(JsonResponse::ok(json!({"ok": true})).into())
        }
        _ => Ok(Outcome::Text {
            status: 405,
            body: "method not allowed",
        }),
    }
}
