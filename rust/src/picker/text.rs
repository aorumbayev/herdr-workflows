//! String helpers. `truncate` / `strip_file_prefix` port `src/tui/text.ts`;
//! `sanitize_display` ports `sanitizeDisplay` from `src/adapter/stdin.ts`
//! (local copy so the picker stays independent of the concurrent herdr
//! adapter port — task 2.x owns the canonical one).

/// `truncate`: keep at most `max` chars, appending `…` when cut. Char-based
/// where the TS slices UTF-16 code units; identical for BMP text.
#[must_use]
pub fn truncate(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if max == 1 {
        return if text.is_empty() { String::new() } else { "…".to_string() };
    }
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max - 1).collect();
    match (chars.next(), chars.next()) {
        (None, _) => head,
        (Some(_), None) => text.to_string(),
        (Some(_), Some(_)) => {
            let mut out = head;
            out.push('…');
            out
        }
    }
}

/// `stripFilePrefix`: drop the leading `file` label plus one `,`/`:` and any
/// following whitespace; untouched when the error does not start with `file`.
#[must_use]
pub fn strip_file_prefix<'a>(error: &'a str, file: &str) -> &'a str {
    let Some(rest) = error.strip_prefix(file) else {
        return error;
    };
    rest.strip_prefix([',', ':'].as_slice())
        .map_or(rest, str::trim_start)
}

/// `sanitizeDisplay`: strip C0 controls from user/evidence text, keeping
/// tab/CR/LF. Applied to picker-collected values before a run starts.
#[must_use]
pub fn sanitize_display(raw: &str) -> String {
    raw.chars()
        .filter(|&c| matches!(c, '\t' | '\n' | '\r') || c >= ' ')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_ellipsis_at_max() {
        assert_eq!(truncate("abcdefghij", 5), "abcd…");
        assert_eq!(truncate("abcd", 5), "abcd");
        assert_eq!(truncate("abcde", 5), "abcde");
        assert_eq!(truncate("anything", 0), "");
        assert_eq!(truncate("anything", 1), "…");
        assert_eq!(truncate("", 1), "");
    }

    #[test]
    fn strip_file_prefix_strips_label_and_separator() {
        let error = "/r/broken.yaml, step 2, agent: unknown agent 'x'";
        assert_eq!(
            strip_file_prefix(error, "/r/broken.yaml"),
            "step 2, agent: unknown agent 'x'"
        );
        assert_eq!(strip_file_prefix("cycle", "/g/chat-broken.yaml"), "cycle");
    }

    #[test]
    fn sanitize_display_drops_c0_keeps_whitespace() {
        assert_eq!(sanitize_display("a\x07b\x1bc\td\ne"), "abc\td\ne");
        assert_eq!(sanitize_display("plain text"), "plain text");
    }
}
