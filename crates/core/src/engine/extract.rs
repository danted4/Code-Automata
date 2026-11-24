//! Finding the answer's JSON object in free text, for providers without structured output.
//!
//! Agents wrap JSON in prose, code fences, or both, and prose itself may contain braces ("returns
//! `{}`"). So: try the whole text, then fenced blocks from last to first, then every balanced
//! top-level `{…}` from last to first. The first object that parses *and* has the expected key wins.
//! Answers come last in a message, so searching from the end finds the answer, not an example
//! quoted before it (2.2.4 took the first thing that parsed).

use serde_json::Value;

pub fn find_object(text: &str, key: &str) -> Option<Value> {
    let matches = |candidate: &str| -> Option<Value> {
        let value: Value = serde_json::from_str(candidate.trim()).ok()?;
        value.get(key)?;
        Some(value)
    };
    if let Some(v) = matches(text) {
        return Some(v);
    }
    for block in fenced_blocks(text).iter().rev() {
        if let Some(v) = matches(block) {
            return Some(v);
        }
    }
    for object in balanced_objects(text).iter().rev() {
        if let Some(v) = matches(object) {
            return Some(v);
        }
    }
    None
}

/// The contents of ```` ``` ```` fenced blocks, any language tag.
fn fenced_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        // Skip the language tag line.
        let body_start = after.find('\n').map_or(after.len(), |i| i + 1);
        let body = &after[body_start..];
        let Some(end) = body.find("```") else { break };
        blocks.push(&body[..end]);
        rest = &body[end + 3..];
    }
    blocks
}

/// Every top-level balanced `{…}` span, aware of JSON strings and escapes.
fn balanced_objects(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' if depth > 0 => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0
                    && let Some(s) = start.take()
                {
                    spans.push(&text[s..=i]);
                }
            }
            _ => {}
        }
    }
    spans
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn plain_json() {
        let v = find_object(r#"{"plan": "x"}"#, "plan").unwrap();
        assert_eq!(v["plan"], "x");
    }

    #[test]
    fn prose_braces_before_the_answer_do_not_win() {
        let text = r#"The handler returns `{}` when empty and `{"ok": true}` otherwise.
Here is the result:
{"subtasks": [{"id": "dev-1"}]}"#;
        let v = find_object(text, "subtasks").unwrap();
        assert_eq!(v["subtasks"][0]["id"], "dev-1");
    }

    #[test]
    fn the_last_fenced_block_with_the_key_wins() {
        let text = "Example format:\n```json\n{\"subtasks\": [\"example\"]}\n```\n\nAnswer:\n```json\n{\"subtasks\": [\"real\"]}\n```\nThanks!";
        assert_eq!(
            find_object(text, "subtasks").unwrap()["subtasks"][0],
            "real"
        );
    }

    #[test]
    fn braces_inside_strings_are_not_structure() {
        let text = r#"Done. {"summary": "added `fn x() { }` and a \"quoted }\" brace", "handoff": ""} bye"#;
        let v = find_object(text, "summary").unwrap();
        assert!(v["summary"].as_str().unwrap().contains("fn x() { }"));
    }

    #[test]
    fn an_object_without_the_key_is_not_an_answer() {
        assert!(find_object(r#"Result: {"other": 1}"#, "plan").is_none());
        assert!(find_object("no json here", "plan").is_none());
        assert!(find_object(r#"{"plan": "unterminated"#, "plan").is_none());
    }

    #[test]
    fn nested_objects_are_found_whole() {
        let text = r#"prefix {"passed": false, "summary": "s", "findings": ["a {b}"], "meta": {"x": {}}} suffix"#;
        let v = find_object(text, "passed").unwrap();
        assert_eq!(v["meta"]["x"], serde_json::json!({}));
    }
}
