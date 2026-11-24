//! Finding the answer's JSON object in free text, for providers without structured output.
//!
//! Agents wrap JSON in prose, code fences, or both, and prose itself contains braces and quotes
//! ("opened the block with `{`"). So every candidate is collected with the position it ends at:
//! the whole text, each fenced block, and a balanced `{…}` starting at *every* `{` (scanned
//! independently, so one stray brace or quote cannot hide what follows). Candidates are tried from
//! the one that ends last; the first that parses and has the expected key wins. Answers come last
//! in a message, so this finds the answer rather than an example shown before it, fenced or not.

use serde_json::Value;

/// Only the end of a very long message is searched; the answer is at the end.
const SEARCH_BYTES: usize = 256 * 1024;
/// Upper bound on `{` positions scanned, from the end, to keep the search bounded.
const MAX_STARTS: usize = 4000;

pub fn find_object(text: &str, key: &str) -> Option<Value> {
    let text = tail(text, SEARCH_BYTES);
    // (end offset, start offset, candidate)
    let mut candidates: Vec<(usize, usize, &str)> = vec![(text.len(), 0, text)];
    candidates.extend(fenced_blocks(text));
    candidates.extend(balanced_objects(text));
    // Ends last first; for the same end, the longest (outermost) first.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    candidates.into_iter().find_map(|(_, _, candidate)| {
        let value: Value = serde_json::from_str(candidate.trim()).ok()?;
        value.get(key)?;
        Some(value)
    })
}

fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The contents of ```` ``` ```` fenced blocks, any language tag, with where each ends.
fn fenced_blocks(text: &str) -> Vec<(usize, usize, &str)> {
    let mut blocks = Vec::new();
    let mut offset = 0;
    while let Some(found) = text[offset..].find("```") {
        let open = offset + found + 3;
        let body_start = text[open..].find('\n').map_or(text.len(), |i| open + i + 1);
        let Some(len) = text[body_start..].find("```") else {
            break;
        };
        let body_end = body_start + len;
        blocks.push((body_end, body_start, &text[body_start..body_end]));
        offset = body_end + 3;
    }
    blocks
}

/// A balanced `{…}` from each `{` position, each scanned on its own (aware of JSON strings and
/// escapes from that start), with where it ends. Starts that never close are skipped.
fn balanced_objects(text: &str) -> Vec<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let starts: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == b'{')
        .map(|(i, _)| i)
        .collect();
    let first = starts.len().saturating_sub(MAX_STARTS);
    starts[first..]
        .iter()
        .filter_map(|&start| close_of(bytes, start).map(|end| (end + 1, start, &text[start..=end])))
        .collect()
}

/// Index of the `}` that closes the object opened at `start`, if any.
fn close_of(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
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
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
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
    fn an_unbalanced_brace_or_quote_in_prose_does_not_hide_the_answer() {
        let text =
            "I opened the block with `{` in api.rs.\n{\"summary\": \"done\", \"handoff\": \"\"}";
        assert_eq!(find_object(text, "summary").unwrap()["summary"], "done");
        let quote = "It said {\"half done\n\nAnswer:\n{\"summary\": \"ok\", \"handoff\": \"\"}";
        assert_eq!(find_object(quote, "summary").unwrap()["summary"], "ok");
    }

    #[test]
    fn a_later_bare_answer_beats_an_earlier_fenced_example() {
        let text = "The format is:\n```json\n{\"passed\": true, \"summary\": \"example\", \"findings\": []}\n```\nMy verdict:\n{\"passed\": false, \"summary\": \"real\", \"findings\": [\"x\"]}";
        let v = find_object(text, "passed").unwrap();
        assert_eq!(v["summary"], "real");
        assert_eq!(v["passed"], false);
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
    fn the_outermost_object_is_preferred_over_a_nested_one() {
        let text = r#"prefix {"passed": false, "summary": "s", "findings": ["a {b}"], "meta": {"x": {}}} suffix"#;
        let v = find_object(text, "passed").unwrap();
        assert_eq!(v["meta"]["x"], serde_json::json!({}));
        let nested = r#"{"summary": "outer", "handoff": "", "detail": {"summary": "inner"}}"#;
        assert_eq!(find_object(nested, "summary").unwrap()["summary"], "outer");
    }

    #[test]
    fn a_long_message_is_searched_from_its_end() {
        let mut text = "x { ".repeat(100_000);
        text.push_str("\n{\"plan\": \"# P\\n## Steps\\n1. a long enough plan here\"}");
        assert!(find_object(&text, "plan").is_some());
    }
}
