//! Placeholder scanning shared by step/input validation and by the runtime
//! substitution pass (`substitute.rs`). Port of the pure scanning helpers in
//! `src/workflows/substitute.ts`.

use std::collections::BTreeMap;

/// Names matched by `\{(pane|selection|prompt|last|error|session|session_file|tab|prev_tab|agent)\}`.
const SIMPLE_PLACEHOLDERS: [&str; 10] = [
    "pane",
    "selection",
    "prompt",
    "last",
    "error",
    "session",
    "session_file",
    "tab",
    "prev_tab",
    "agent",
];

/// `[a-z][a-z0-9_]{0,31}` — `INPUT_NAME_RE`.
pub fn is_input_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    matches!(bytes.first(), Some(b'a'..=b'z'))
        && bytes.len() <= 32
        && bytes[1..]
            .iter()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// One placeholder occurrence: byte span in the scanned text plus resolved
/// name (`"pane"` for simple names, `"input.x"` for input refs). Byte offsets
/// are safe slice boundaries because the delimiting braces are ASCII.
pub(crate) struct PlaceholderMatch {
    pub start: usize,
    pub end: usize,
    pub name: String,
}

/// Matches the TS global regex left to right: at each `{`, the simple-name
/// alternative first, then `{input.<name>}`; unmatched braces are skipped.
/// A successful match never contains `{` in its interior, so resuming the
/// scan one byte past the match start yields the same non-overlapping match
/// sequence as the regex's `lastIndex`.
struct Placeholders<'a> {
    text: &'a str,
    pos: usize,
}

impl Iterator for Placeholders<'_> {
    type Item = PlaceholderMatch;

    fn next(&mut self) -> Option<PlaceholderMatch> {
        let bytes = self.text.as_bytes();
        while self.pos < bytes.len() {
            let i = self.pos;
            self.pos += 1;
            if bytes[i] != b'{' {
                continue;
            }
            let Some(close) = self.text[i + 1..].find('}') else {
                continue;
            };
            let inner = &self.text[i + 1..i + 1 + close];
            let name = if SIMPLE_PLACEHOLDERS.contains(&inner) {
                inner.to_string()
            } else if let Some(name) = inner.strip_prefix("input.") {
                if !is_input_name(name) {
                    continue;
                }
                format!("input.{name}")
            } else {
                continue;
            };
            return Some(PlaceholderMatch {
                start: i,
                end: i + close + 2,
                name,
            });
        }
        None
    }
}

/// All placeholder matches in scan order.
fn placeholders(text: &str) -> Placeholders<'_> {
    Placeholders { text, pos: 0 }
}

/// Match spans for the runtime substitution pass.
pub(crate) fn placeholder_matches(text: &str) -> impl Iterator<Item = PlaceholderMatch> + '_ {
    placeholders(text)
}

/// First `{placeholder}` in `command` — `commandHasPlaceholder`.
pub fn first_placeholder(command: &str) -> Option<String> {
    placeholders(command).next().map(|m| m.name)
}

/// `textHasSession` — plain substring test, identical to the TS `includes`.
pub fn text_has_session(text: &str) -> bool {
    text.contains("{session}") || text.contains("{session_file}")
}

/// `textHasPrompt`.
pub fn text_has_prompt(text: &str) -> bool {
    text.contains("{prompt}")
}

/// Input names referenced by `{input.<name>}` in order — `textInputRefs`.
pub fn text_input_refs(text: &str) -> Vec<String> {
    placeholders(text)
        .filter_map(|m| m.name.strip_prefix("input.").map(String::from))
        .collect()
}

/// `^\{input\.([a-z][a-z0-9_]{0,31})\}$` — `AGENT_INPUT_RE`. Returns the input name.
pub fn agent_input_ref(name: &str) -> Option<String> {
    let inner = name.strip_prefix("{input.")?.strip_suffix('}')?;
    is_input_name(inner).then(|| inner.to_string())
}

/// `walkParams`: visit every string leaf in a params tree.
fn walk_params(value: &serde_json::Value, visit: &mut impl FnMut(&str)) {
    match value {
        serde_json::Value::String(s) => visit(s),
        serde_json::Value::Array(items) => {
            for item in items {
                walk_params(item, visit);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                walk_params(item, visit);
            }
        }
        _ => {}
    }
}

fn walk_all(params: Option<&BTreeMap<String, serde_json::Value>>, visit: &mut impl FnMut(&str)) {
    if let Some(params) = params {
        for value in params.values() {
            walk_params(value, visit);
        }
    }
}

/// `paramsHaveSession`.
pub fn params_have_session(params: Option<&BTreeMap<String, serde_json::Value>>) -> bool {
    let mut found = false;
    walk_all(params, &mut |s| found |= text_has_session(s));
    found
}

/// `paramsHavePrompt`.
pub fn params_have_prompt(params: Option<&BTreeMap<String, serde_json::Value>>) -> bool {
    let mut found = false;
    walk_all(params, &mut |s| found |= text_has_prompt(s));
    found
}

/// `paramsInputRefs`.
pub fn params_input_refs(params: Option<&BTreeMap<String, serde_json::Value>>) -> Vec<String> {
    let mut refs = Vec::new();
    walk_all(params, &mut |s| refs.extend(text_input_refs(s)));
    refs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_name_bounds() {
        assert!(is_input_name("a"));
        assert!(is_input_name("a_b9"));
        assert!(is_input_name(&"a".repeat(32)));
        assert!(!is_input_name(""));
        assert!(!is_input_name("A"));
        assert!(!is_input_name("_a"));
        assert!(!is_input_name("9a"));
        assert!(!is_input_name("a-b"));
        assert!(!is_input_name(&"a".repeat(33)));
    }

    #[test]
    fn first_placeholder_finds_simple_names() {
        assert_eq!(first_placeholder("echo {pane}"), Some("pane".to_string()));
        assert_eq!(
            first_placeholder("{session_file} rest"),
            Some("session_file".to_string())
        );
        assert_eq!(first_placeholder("none here"), None);
        assert_eq!(first_placeholder("{branch}"), None);
        assert_eq!(first_placeholder("{unclosed"), None);
    }

    #[test]
    fn first_placeholder_finds_input_refs() {
        assert_eq!(
            first_placeholder("echo {input.x}"),
            Some("input.x".to_string())
        );
        assert_eq!(first_placeholder("{input.Bad}"), None);
        assert_eq!(first_placeholder("{input.}"), None);
        assert_eq!(first_placeholder("{input.x"), None);
    }

    #[test]
    fn first_placeholder_respects_scan_order() {
        assert_eq!(
            first_placeholder("{selection} then {pane}"),
            Some("selection".to_string())
        );
        assert_eq!(first_placeholder("{{pane}}"), Some("pane".to_string()));
        assert_eq!(
            first_placeholder("{bogus} {session}"),
            Some("session".to_string())
        );
    }

    #[test]
    fn session_and_prompt_substrings() {
        assert!(text_has_session("{session}"));
        assert!(text_has_session("{session_file}"));
        assert!(!text_has_session("{sessionx}"));
        assert!(text_has_prompt("a {prompt} b"));
        assert!(!text_has_prompt("{promptx}"));
    }

    #[test]
    fn input_refs_collects_in_order() {
        assert_eq!(
            text_input_refs("{input.b} {pane} {input.a}"),
            vec!["b".to_string(), "a".to_string()]
        );
        assert_eq!(text_input_refs("none"), Vec::<String>::new());
    }

    #[test]
    fn agent_input_ref_requires_full_match() {
        assert_eq!(
            agent_input_ref("{input.target}"),
            Some("target".to_string())
        );
        assert_eq!(agent_input_ref("x{input.target}"), None);
        assert_eq!(agent_input_ref("{input.Target}"), None);
        assert_eq!(agent_input_ref("claude"), None);
    }

    #[test]
    fn params_walkers_descend_arrays_and_objects() {
        let params: BTreeMap<String, serde_json::Value> = serde_json::from_str(
            r#"{"items": ["{session}", {"deep": ["{prompt}", "{input.x}"]}, 3, null]}"#,
        )
        .expect("valid json");
        let params = Some(params);
        assert!(params_have_session(params.as_ref()));
        assert!(params_have_prompt(params.as_ref()));
        assert_eq!(params_input_refs(params.as_ref()), vec!["x".to_string()]);

        let empty: Option<BTreeMap<String, serde_json::Value>> = None;
        assert!(!params_have_session(empty.as_ref()));
        assert!(!params_have_prompt(empty.as_ref()));
        assert!(params_input_refs(empty.as_ref()).is_empty());
    }
}
