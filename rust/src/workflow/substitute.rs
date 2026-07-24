//! Runtime substitution pass. Port of `substitute` / `substituteParams` in
//! `src/workflows/substitute.ts` (task 1.6). Placeholder scanning lives in
//! `placeholder.rs`; load-time legality rules (no placeholders in command
//! text, `{session}`/`{session_file}` stdin-only) live in `steps.rs`.

use std::collections::BTreeMap;

use super::placeholder::placeholder_matches;

/// Invocation values for `{placeholder}` substitution — `PlaceholderValues`
/// in `src/workflows/errors.ts`, built by the runner from the invocation
/// context (`buildPlaceholders` in `src/context.ts`). Every field defaults to
/// empty; `tab`/`prev_tab` are threaded by the dispatch loop (`pushTab`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaceholderValues {
    pub pane: String,
    pub selection: String,
    pub prompt: String,
    pub last: String,
    pub error: String,
    pub session: String,
    pub session_file: String,
    pub tab: String,
    pub prev_tab: String,
    pub agent: String,
    pub inputs: BTreeMap<String, String>,
}

impl PlaceholderValues {
    /// Value for one matched placeholder name; unknown names and missing
    /// inputs substitute to `""` (TS `?? ""`).
    fn get(&self, name: &str) -> &str {
        if let Some(input) = name.strip_prefix("input.") {
            return self.inputs.get(input).map_or("", String::as_str);
        }
        match name {
            "pane" => self.pane.as_str(),
            "selection" => self.selection.as_str(),
            "prompt" => self.prompt.as_str(),
            "last" => self.last.as_str(),
            "error" => self.error.as_str(),
            "session" => self.session.as_str(),
            "session_file" => self.session_file.as_str(),
            "tab" => self.tab.as_str(),
            "prev_tab" => self.prev_tab.as_str(),
            "agent" => self.agent.as_str(),
            _ => "",
        }
    }
}

/// `substitute` — replace every `{placeholder}` / `{input.<name>}` match left
/// to right. Unknown tokens (`{branch}`) and unmatched braces pass through
/// untouched, matching the TS regex replace.
pub fn substitute(template: &str, values: &PlaceholderValues) -> String {
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0;
    for m in placeholder_matches(template) {
        out.push_str(&template[cursor..m.start]);
        out.push_str(values.get(&m.name));
        cursor = m.end;
    }
    out.push_str(&template[cursor..]);
    out
}

fn substitute_value(value: &serde_json::Value, values: &PlaceholderValues) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => serde_json::Value::String(substitute(text, values)),
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| substitute_value(item, values))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), substitute_value(item, values)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `substituteParams` — deep-substitute every string leaf of a herdr step's
/// params; arrays/objects are rebuilt and non-strings preserved (`walkParams`).
/// `None` in → `None` out (TS `undefined`).
pub fn substitute_params(
    params: Option<&BTreeMap<String, serde_json::Value>>,
    values: &PlaceholderValues,
) -> Option<BTreeMap<String, serde_json::Value>> {
    params.map(|params| {
        params
            .iter()
            .map(|(key, value)| (key.clone(), substitute_value(value, values)))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn values(inputs: &[(&str, &str)]) -> PlaceholderValues {
        PlaceholderValues {
            inputs: inputs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            ..PlaceholderValues::default()
        }
    }

    #[test]
    fn unknown_token_passes_through() {
        assert_eq!(substitute("{branch}", &values(&[])), "{branch}");
    }

    #[test]
    fn tab_prev_tab_agent_substitute() {
        let values = PlaceholderValues {
            tab: "t2".to_string(),
            prev_tab: "t1".to_string(),
            agent: "codex".to_string(),
            ..PlaceholderValues::default()
        };
        assert_eq!(
            substitute("t={tab} p={prev_tab} a={agent}", &values),
            "t=t2 p=t1 a=codex"
        );
    }

    #[test]
    fn input_refs_substitute_from_inputs_map() {
        assert_eq!(
            substitute("to {input.target}!", &values(&[("target", "codex")])),
            "to codex!"
        );
        assert_eq!(substitute("{input.missing}", &values(&[])), "");
    }

    #[test]
    fn all_simple_placeholders_substitute_and_unset_becomes_empty() {
        let values = PlaceholderValues {
            pane: "P".to_string(),
            selection: "S".to_string(),
            prompt: "pr".to_string(),
            last: "L".to_string(),
            error: "E".to_string(),
            session: "se".to_string(),
            session_file: "sf".to_string(),
            ..PlaceholderValues::default()
        };
        assert_eq!(
            substitute(
                "{pane}|{selection}|{prompt}|{last}|{error}|{session}|{session_file}",
                &values
            ),
            "P|S|pr|L|E|se|sf"
        );
        assert_eq!(substitute("{pane}{last}", &PlaceholderValues::default()), "");
    }

    #[test]
    fn nested_and_repeated_braces_match_regex_behavior() {
        let values = PlaceholderValues {
            pane: "x".to_string(),
            ..PlaceholderValues::default()
        };
        // TS regex matches the inner `{pane}` and continues after it.
        assert_eq!(substitute("{{pane}}", &values), "{x}");
        assert_eq!(substitute("{pane}/{pane}", &values), "x/x");
        assert_eq!(substitute("a{pane}b{pane", &values), "axb{pane");
        assert_eq!(substitute("{bogus} {pane}", &values), "{bogus} x");
    }

    #[test]
    fn params_substitution_descends_arrays_and_preserves_non_strings() {
        let params: BTreeMap<String, serde_json::Value> = serde_json::from_value(json!({
            "items": ["{input.target}", { "prompt": "{prompt}", "count": 3 }, false, null]
        }))
        .expect("valid json");
        let values = PlaceholderValues {
            prompt: "ship it".to_string(),
            inputs: values(&[("target", "codex")]).inputs,
            ..PlaceholderValues::default()
        };
        let expected: BTreeMap<String, serde_json::Value> = serde_json::from_value(json!({
            "items": ["codex", { "prompt": "ship it", "count": 3 }, false, null]
        }))
        .expect("valid json");
        assert_eq!(substitute_params(Some(&params), &values), Some(expected));
    }

    #[test]
    fn params_substitution_preserves_proto_key_as_data() {
        let params: BTreeMap<String, serde_json::Value> =
            serde_json::from_value(json!({ "payload": { "__proto__": { "preserved": "yes" } } }))
                .expect("valid json");
        let output = substitute_params(Some(&params), &values(&[])).expect("params present");
        let payload = output.get("payload").expect("payload key");
        assert_eq!(
            payload,
            &json!({ "__proto__": { "preserved": "yes" } }),
            "__proto__ survives as ordinary data"
        );
    }

    #[test]
    fn params_none_stays_none() {
        assert_eq!(substitute_params(None, &values(&[])), None);
    }
}
