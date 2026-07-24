//! Provided-input resolution. Port of `src/runner/inputs.ts`: merge provided
//! values with declared defaults; reject unknown, missing, and out-of-set
//! values.

use std::collections::BTreeMap;

use crate::workflow::errors::InputSpec;

/// `resolveInputValues`. Error strings are the pinned TS messages.
///
/// # Errors
/// `String` naming the first violation: unknown provided input, missing
/// required input, or a value outside the declared options.
pub fn resolve_input_values(
    specs: &[InputSpec],
    provided: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    for name in provided.keys() {
        if !specs.iter().any(|spec| &spec.name == name) {
            return Err(format!("unknown input '{name}'"));
        }
    }
    let mut values = BTreeMap::new();
    for spec in specs {
        let value = provided.get(&spec.name).or(spec.default.as_ref());
        let Some(value) = value else {
            return Err(format!(
                "missing input '{}' (--input {}=…)",
                spec.name, spec.name
            ));
        };
        if let Some(options) = &spec.options {
            if !options.contains(value) {
                return Err(format!(
                    "input '{}' must be one of: {}",
                    spec.name,
                    options.join(", ")
                ));
            }
        }
        values.insert(spec.name.clone(), value.clone());
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, options: Option<Vec<String>>, default: Option<&str>) -> InputSpec {
        InputSpec {
            name: name.to_string(),
            label: name.to_string(),
            options,
            dynamic_options: false,
            default: default.map(str::to_string),
        }
    }

    fn provided(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn missing_required_names_flag_form() {
        let err = resolve_input_values(&[spec("constructor", None, None)], &BTreeMap::new())
            .expect_err("missing");
        assert_eq!(err, "missing input 'constructor' (--input constructor=…)");
        // A provided value for a name that shadows a JS prototype key resolves fine.
        let ok = resolve_input_values(
            &[spec("constructor", None, None)],
            &provided(&[("constructor", "value")]),
        )
        .expect("resolves");
        assert_eq!(ok.get("constructor").map(String::as_str), Some("value"));
    }

    #[test]
    fn unknown_provided_rejected_before_missing_check() {
        let err = resolve_input_values(
            &[spec("focus", None, None)],
            &provided(&[("focus", "x"), ("extra", "y")]),
        )
        .expect_err("unknown");
        assert_eq!(err, "unknown input 'extra'");
    }

    #[test]
    fn default_fills_and_choice_membership_enforced() {
        let specs = [spec(
            "mode",
            Some(vec!["fast".into(), "slow".into()]),
            Some("fast"),
        )];
        let ok = resolve_input_values(&specs, &BTreeMap::new()).expect("default fills");
        assert_eq!(ok.get("mode").map(String::as_str), Some("fast"));
        let err = resolve_input_values(&specs, &provided(&[("mode", "warp")])).expect_err("bad");
        assert_eq!(err, "input 'mode' must be one of: fast, slow");
    }
}
