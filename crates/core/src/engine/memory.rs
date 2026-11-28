//! Project memory: what agents learned about a project, kept for the tasks after them.
//!
//! One file, `.code-automata/memory.md`, at the project root (the workspace folder for a
//! workspace), not committed. Development and QA answers may carry `learnings`, lasting facts about
//! the project (a build quirk, a convention, a pitfall), never a task's progress; the engine
//! appends each as one line, `- YYYY-MM-DD · <task-id>: <text>`, skipping one already there. Agents
//! never write the file. Every prompt gets its newest lines up to [`PROMPT_BYTES`]; the user reads,
//! prunes and edits the file in Settings. A repository opened on its own and inside a workspace
//! keeps two memories, one per project.

use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;

/// How much of the memory a prompt gets: the newest lines that fit.
pub const PROMPT_BYTES: usize = 8 * 1024;
/// A learning longer than this is cut.
pub const MAX_ENTRY_CHARS: usize = 500;
/// The file's first line.
const HEADING: &str = "# Project memory";

pub fn path(project: &ProjectDir) -> PathBuf {
    project.state_dir().join("memory.md")
}

/// The memory file's text; empty when there is none.
pub async fn read(project: &ProjectDir) -> Result<String> {
    read_path(&path(project)).await
}

async fn read_path(path: &Path) -> Result<String> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io_at(path)(e)),
    }
}

/// Replace the memory with the user's text (from Settings).
pub async fn write(project: &ProjectDir, text: &str) -> Result<()> {
    project.ensure_git_exclude().await?;
    crate::store::write_text_atomic(&path(project), text).await
}

/// The entries a prompt gets (newest last), and whether older ones were left out.
pub fn for_prompt(text: &str) -> (String, bool) {
    let entries: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty() && l.trim() != HEADING)
        .collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in entries.iter().rev() {
        // A line that does not fit (one long one the user wrote) is left out; older, shorter
        // ones may still fit.
        if size + line.len() + 1 > PROMPT_BYTES {
            continue;
        }
        size += line.len() + 1;
        kept.push(line);
    }
    let truncated = kept.len() < entries.len();
    kept.reverse();
    (kept.join("\n"), truncated)
}

/// The text with `learnings` added as new lines; `None` when none is new.
pub fn with_learnings(
    text: &str,
    learnings: &[String],
    task_id: &str,
    date: &str,
) -> Option<String> {
    let known: Vec<&str> = text.lines().filter_map(entry_text).collect();
    let mut added: Vec<String> = Vec::new();
    for learning in learnings {
        let one_line: String = learning.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut: String = one_line.chars().take(MAX_ENTRY_CHARS).collect();
        if cut.is_empty() || known.contains(&cut.as_str()) || added.contains(&cut) {
            continue;
        }
        added.push(cut);
    }
    if added.is_empty() {
        return None;
    }
    let mut out = if text.trim().is_empty() {
        format!("{HEADING}\n\n")
    } else if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    };
    for learning in added {
        out.push_str(&format!("- {date} · {task_id}: {learning}\n"));
    }
    Some(out)
}

/// The learning in one of the file's lines.
fn entry_text(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix("- ")?;
    rest.split_once(": ").map(|(_, text)| text.trim())
}

/// Today's date (`YYYY-MM-DD`, local time).
pub fn today() -> String {
    jiff::ZonedDateTime::now().date().to_string()
}

/// Append `learnings` from `task_id` to the project's memory. Serialised by `lock`, so two tasks
/// finishing at once both land.
pub async fn append(
    project: &ProjectDir,
    lock: &tokio::sync::Mutex<()>,
    learnings: &[String],
    task_id: &str,
) -> Result<()> {
    if learnings.iter().all(|l| l.trim().is_empty()) {
        return Ok(());
    }
    let _guard = lock.lock().await;
    let text = read(project).await?;
    match with_learnings(&text, learnings, task_id, &today()) {
        Some(next) => write(project, &next).await,
        None => Ok(()),
    }
}

/// Refuse a memory that cannot be one (the editor's input).
pub fn validate(text: &str) -> Result<()> {
    if text.len() > 256 * 1024 {
        return Err(CoreError::Patch(
            "the project memory is too large (more than 256 KB)".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn learnings_are_added_once_and_on_one_line() {
        let first = with_learnings(
            "",
            &["Use pnpm,\n not npm".into(), "  ".into()],
            "task-1",
            "2026-11-28",
        )
        .unwrap_or_default();
        assert_eq!(
            first,
            "# Project memory\n\n- 2026-11-28 · task-1: Use pnpm, not npm\n"
        );
        // The same learning again (from another task) is not added.
        assert_eq!(
            with_learnings(
                &first,
                &["Use pnpm, not npm".into()],
                "task-2",
                "2026-11-29"
            ),
            None
        );
        let second = with_learnings(
            &first,
            &["Tests need DATABASE_URL".into()],
            "task-2",
            "2026-11-29",
        )
        .unwrap_or_default();
        assert!(second.ends_with("- 2026-11-29 · task-2: Tests need DATABASE_URL\n"));
        let long = "x".repeat(900);
        let cut = with_learnings("", &[long], "t", "d").unwrap_or_default();
        assert!(cut.lines().last().is_some_and(|l| l.len() < 560));
    }

    #[test]
    fn prompts_get_the_newest_lines_that_fit() {
        let mut text = String::from("# Project memory\n\n");
        for i in 0..400 {
            text.push_str(&format!(
                "- 2026-11-28 · t: learning number {i} with some words\n"
            ));
        }
        let (kept, truncated) = for_prompt(&text);
        assert!(truncated);
        assert!(kept.len() <= PROMPT_BYTES);
        assert!(kept.ends_with("learning number 399 with some words"));
        assert!(!kept.contains("# Project memory"));
        let (all, cut) = for_prompt("- a: b\n");
        assert_eq!((all.as_str(), cut), ("- a: b", false));
        // One huge last line does not empty the memory.
        let huge = format!("- a: keep me\n- b: {}\n", "x".repeat(PROMPT_BYTES * 2));
        let (kept, truncated) = for_prompt(&huge);
        assert_eq!((kept.as_str(), truncated), ("- a: keep me", true));
    }
}
