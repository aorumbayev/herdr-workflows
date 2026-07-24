//! Cross-field step rules. Port of `src/workflows/refine.ts`.

use std::collections::HashSet;

/// Verb keys in `VERBS` order — drives the multi-verb message wording.
const VERBS: [&str; 5] = ["shell", "open", "agent", "herdr", "run"];

const MODIFIERS: [&str; 7] = [
    "stdin",
    "prompt",
    "params",
    "wait",
    "wait_for",
    "timeout",
    "close_source",
];

/// One refine issue: the positioned error's optional key plus its message.
pub struct RefineIssue {
    pub key: Option<&'static str>,
    pub message: String,
}

/// `refineStepVerbs`. `present` holds the keys present in the step mapping; the
/// caller runs this only when schema-level validation did not abort the step
/// (Zod skips `superRefine` after `invalid_type`/`invalid_value`/`unrecognized_keys`).
pub fn refine_step_verbs(present: &HashSet<&str>) -> Vec<RefineIssue> {
    let verbs: Vec<&str> = VERBS.into_iter().filter(|v| present.contains(v)).collect();
    if verbs.is_empty() {
        return vec![RefineIssue {
            key: None,
            message: "step has no verb".to_string(),
        }];
    }
    if verbs.len() > 1 {
        return vec![RefineIssue {
            key: None,
            message: format!("step has multiple verbs: {}", verbs.join(", ")),
        }];
    }
    let verb = verbs[0];
    let mut issues = Vec::new();
    let placements: [(&str, bool, &str); 6] = [
        ("stdin", verb == "shell", "stdin only allowed on shell"),
        ("prompt", verb == "agent", "prompt only allowed on agent"),
        ("params", verb == "herdr", "params only allowed on herdr"),
        ("wait", verb == "agent", "wait only allowed on agent"),
        ("wait_for", verb == "open", "wait_for only allowed on open"),
        (
            "close_source",
            verb == "agent",
            "close_source only allowed on agent",
        ),
    ];
    for (key, allowed, message) in placements {
        if present.contains(key) && !allowed {
            issues.push(RefineIssue {
                key: Some(key),
                message: message.to_string(),
            });
        }
    }
    if present.contains("timeout") && !present.contains("wait") && !present.contains("wait_for") {
        issues.push(RefineIssue {
            key: Some("timeout"),
            message: "timeout requires wait or wait_for".to_string(),
        });
    }
    if verb == "run" && MODIFIERS.iter().any(|k| present.contains(k)) {
        issues.push(RefineIssue {
            key: Some("run"),
            message: "run steps take no modifiers".to_string(),
        });
    }
    issues
}
