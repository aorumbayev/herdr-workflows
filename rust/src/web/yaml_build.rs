//! YAML emitter for the web workbench. Port of `src/web/yaml-build.ts`:
//! byte-exact scalar rules so `dump_workflow` output round-trips through
//! `parse::parse_raw` unchanged (the TS corpus in `test/yaml-build.test.ts`
//! is ported to `rust/tests/web_yaml_build.rs`).

use crate::workflow::types::{RawOptions, RawStep, RawWorkflow, WaitDone};

const IND: &str = "  ";

/// A scalar is safe unquoted in block context when it starts with no YAML
/// indicator, carries no `: `/` #`/trailing-`:` that would flip it into a
/// mapping or comment, and would not be re-parsed as a bool/null/number.
/// Port of `plainOk` (regexes unrolled — no regex crate in the dep set).
fn plain_ok(s: &str) -> bool {
    let Some(first) = s.chars().next() else {
        return false;
    };
    if "-?:,[]{}#&*!|>'\"%@`".contains(first) || first.is_whitespace() {
        return false;
    }
    let mut prev = first;
    for c in s.chars().skip(1) {
        if (prev == ':' && c.is_whitespace()) || (prev.is_whitespace() && c == '#') {
            return false;
        }
        prev = c;
    }
    if s.ends_with(':') || prev.is_whitespace() {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "null" | "~") {
        return false;
    }
    if yaml_number_like(&lower) {
        return false;
    }
    true
}

/// `/^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-f]+|\.(nan|inf))$/i` —
/// `s` must already be ASCII-lowercased.
fn yaml_number_like(s: &str) -> bool {
    let t = s.strip_prefix(['-', '+']).unwrap_or(s);
    if t == ".nan" || t == ".inf" {
        return true;
    }
    if let Some(hex) = t.strip_prefix("0x") {
        return !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    let b = t.as_bytes();
    if b.first().is_none_or(|c| !c.is_ascii_digit()) {
        return false;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'_') {
        i += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if i < b.len() && b[i] == b'e' {
        i += 1;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// Double-quoted YAML scalar: only `\`, `"`, `\n` are escaped, exactly like
/// the TS `quoted()`.
fn quoted(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Literal blocks survive intact only when no line has leading/trailing
/// whitespace; anything else falls back to a double-quoted scalar so content
/// round-trips byte-exact.
fn block_safe(v: &str) -> bool {
    v.split('\n').all(|ln| ln == ln.trim() || ln.is_empty())
}

/// Emit `key: value`, using a literal block scalar for multi-line strings so
/// prompts stay readable. `|-` strips trailing newlines, so values ending in
/// `\n` (or with ragged whitespace) fall back to a double-quoted scalar to
/// round-trip byte-exact.
fn field(lines: &mut Vec<String>, indent: &str, key: &str, v: &str) {
    if v.contains('\n') {
        if !v.ends_with('\n') && block_safe(v) {
            lines.push(format!("{indent}{key}: |-"));
            for ln in v.split('\n') {
                lines.push(format!("{indent}{IND}{ln}"));
            }
            return;
        }
        lines.push(format!("{indent}{key}: {}", quoted(v)));
        return;
    }
    let value = if plain_ok(v) {
        v.to_string()
    } else {
        quoted(v)
    };
    lines.push(format!("{indent}{key}: {value}"));
}

/// Emit a scalar position that is not a `field` (input names, option items,
/// `on_fail`).
fn scalar_value(v: &str) -> String {
    if plain_ok(v) {
        v.to_string()
    } else {
        quoted(v)
    }
}

fn dump_step(step: &RawStep) -> Vec<String> {
    let mut m: Vec<String> = Vec::new();
    let i = format!("{IND}{IND}"); // step mapping keys sit at 4-space indent
    if let Some(shell) = &step.shell {
        field(&mut m, &i, "shell", shell);
        if let Some(stdin) = &step.stdin {
            field(&mut m, &i, "stdin", stdin);
        }
    } else if let Some(open) = &step.open {
        field(&mut m, &i, "open", open);
        if let Some(wait_for) = &step.wait_for {
            field(&mut m, &i, "wait_for", wait_for);
        }
        if let Some(timeout) = step.timeout {
            m.push(format!("{i}timeout: {timeout}"));
        }
    } else if let Some(agent) = &step.agent {
        field(&mut m, &i, "agent", agent);
        if let Some(prompt) = &step.prompt {
            field(&mut m, &i, "prompt", prompt);
        }
        if step.wait == Some(WaitDone::Done) {
            m.push(format!("{i}wait: done"));
        }
        if let Some(timeout) = step.timeout {
            m.push(format!("{i}timeout: {timeout}"));
        }
        if let Some(close_source) = step.close_source {
            m.push(format!("{i}close_source: {close_source}"));
        }
    } else if let Some(herdr) = &step.herdr {
        field(&mut m, &i, "herdr", herdr);
        if let Some(params) = &step.params {
            let params = serde_json::to_string(params).expect("JSON map serialization cannot fail");
            m.push(format!("{i}params: {params}"));
        }
    } else if let Some(run) = &step.run {
        field(&mut m, &i, "run", run);
    }
    if m.is_empty() {
        m.push(format!("{i}shell: \"\""));
    }
    // Fold the first key onto the sequence dash: "    shell: x" -> "  - shell: x".
    m[0] = format!("{IND}- {}", &m[0][i.len()..]);
    m
}

fn dump_inputs(lines: &mut Vec<String>, doc: &RawWorkflow) {
    let Some(inputs) = &doc.inputs else {
        return;
    };
    lines.push("inputs:".to_string());
    // TS iterates `Object.entries(inputs)` in declaration order; `parse_raw`
    // records it in `input_order`. Fall back to map (sorted) order for
    // documents built from JSON, where order is unrecorded.
    let order: Vec<&str> = if doc.input_order.is_empty() {
        inputs.keys().map(String::as_str).collect()
    } else {
        doc.input_order.iter().map(String::as_str).collect()
    };
    for name in order {
        let Some(inp) = inputs.get(name) else {
            continue;
        };
        lines.push(format!("{IND}{}:", scalar_value(name)));
        if let Some(label) = &inp.label {
            lines.push(format!("{IND}{IND}label: {}", scalar_value(label)));
        }
        if let Some(options) = &inp.options {
            match options {
                RawOptions::Choices(choices) => {
                    lines.push(format!("{IND}{IND}options:"));
                    for o in choices {
                        lines.push(format!("{IND}{IND}{IND}- {}", scalar_value(o)));
                    }
                }
                RawOptions::Command(command) => {
                    lines.push(format!("{IND}{IND}options: {}", scalar_value(command)));
                }
            }
        }
        if let Some(default) = &inp.default {
            lines.push(format!("{IND}{IND}default: {}", scalar_value(default)));
        }
    }
}

/// Serialize a workflow to readable block YAML with a blank line between
/// steps. Deliberately more generous with whitespace than the validator
/// requires.
#[must_use]
pub fn dump_workflow(doc: &RawWorkflow) -> String {
    let mut lines: Vec<String> = Vec::new();
    if doc.inputs.as_ref().is_some_and(|inputs| !inputs.is_empty()) {
        dump_inputs(&mut lines, doc);
        lines.push(String::new());
    }
    lines.push("steps:".to_string());
    for (i, step) in doc.steps.iter().enumerate() {
        if i > 0 {
            lines.push(String::new());
        }
        lines.extend(dump_step(step));
    }
    if let Some(on_fail) = &doc.on_fail {
        lines.push(String::new());
        lines.push(format!("on_fail: {}", scalar_value(on_fail)));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}
