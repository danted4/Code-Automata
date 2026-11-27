//! Prompt templates.
//!
//! Planning prompts are ported from 2.2.4 (`src/lib/prompts/defaults.ts`, question generation in
//! `start-planning`). Dev, QA, resume, triage and repair prompts are new: 2.2.4 gave a subtask
//! agent only its own label and detail, so it started blind. Here every dev agent sees the task,
//! the plan, the whole subtask list, earlier handoff notes and, on resume, its partial work.
//!
//! Every prompt ends with output instructions generated from the step's [`AgentOutput`], so the
//! wording cannot drift from what the validator expects. Custom templates (settings) replace only
//! the editable part of the plan and subtask prompts.

use std::fmt::Write as _;

use super::output::{AgentOutput, DevOut, PlanOut, QaOut, QuestionsOut, SubtasksOut, TriageOut};
use super::settings::Settings;
use crate::git::WorkingDiff;
use crate::task::{Subtask, SubtaskKind, SubtaskStatus, Task};
use crate::util::ROOT_REPO;

/// Replace `{{name}}` placeholders in one pass over the template. Inserted values are never
/// scanned again, so a `{{plan}}` inside a task description stays literal. Unknown placeholders are
/// left as they are.
pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        match after.find("}}") {
            Some(close) => {
                let name = &after[..close];
                match vars.iter().find(|(n, _)| *n == name) {
                    Some((_, value)) => out.push_str(value),
                    None => {
                        out.push_str("{{");
                        out.push_str(name);
                        out.push_str("}}");
                    }
                }
                rest = &after[close + 2..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// How to answer, appended to every prompt.
pub fn output_instructions<T: AgentOutput>() -> String {
    format!(
        "\n\n# Answer format\n\n\
         End with your answer as one JSON object, as the last thing in your final message, \
         shaped like this:\n\n{}\n\n\
         Put it in your message, not in a file: nothing you write to disk is read as the answer.",
        T::example()
    )
}

fn task_header(task: &Task) -> String {
    let mut s = format!("**Task:** {}\n", task.title);
    if !task.description.trim().is_empty() {
        let _ = writeln!(s, "**Description:** {}", task.description.trim());
    }
    s
}

const READ_ONLY_NOTE: &str = "This is a planning step: read the code, but do not create, edit or \
delete any file and do not run commands that change anything. Anything you change is discarded.";

pub fn questions(task: &Task) -> String {
    format!(
        "You are an AI planning assistant helping to plan the following task.\n\n{}\n\
         # Planning: clarifying questions\n\n\
         Before a plan is written, ask the questions whose answers would change the plan. \
         Look at the code first so you only ask what the code cannot tell you. Cover, where \
         relevant: technical approach and architecture, the user's preferences and priorities, \
         edge cases and error handling, performance, and how the result should be tested.\n\n\
         Ask between 3 and 10 questions. Give each 2 to 5 short options where options make \
         sense (the user can always add a note), and mark whether it must be answered.\n\n{READ_ONLY_NOTE}{}",
        task_header(task),
        output_instructions::<QuestionsOut>()
    )
}

/// The editable part of the plan prompt; a custom template from settings replaces it.
pub const DEFAULT_PLAN_TEMPLATE: &str =
    "You are an AI planning assistant. Write an implementation \
plan for the task below.

{{task}}
{{answers}}
# Planning: implementation plan

Read the relevant code first. Then write a plan in markdown that a developer could follow without \
asking questions, with these sections:

- `# <title>`
- `## Overview`: what will change and why
- `## Technical Approach`: the design, and the alternatives you rejected
- `## Implementation Steps`: a numbered list of concrete steps
- `## Files to Modify`: paths, with what changes in each
- `## Testing Strategy`: how the change will be verified
- `## Potential Issues`: risks and edge cases
- `## Success Criteria`: how to tell the task is done";

fn answers_block(task: &Task) -> String {
    let answered: Vec<_> = task
        .planning
        .questions
        .iter()
        .filter(|q| q.answer.is_some())
        .collect();
    if answered.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n# The user's answers to your questions\n\n");
    for q in answered {
        let a = q.answer.as_ref().map(|a| {
            let mut parts = Vec::new();
            if let Some(c) = &a.choice {
                parts.push(c.clone());
            }
            if let Some(n) = a.note.as_ref().filter(|n| !n.trim().is_empty()) {
                parts.push(format!("(note: {})", n.trim()));
            }
            if parts.is_empty() {
                "No answer".to_string()
            } else {
                parts.join(" ")
            }
        });
        let _ = writeln!(s, "- Q: {}\n  A: {}", q.text, a.unwrap_or_default());
    }
    s
}

pub fn plan(task: &Task, settings: &Settings) -> String {
    let template = settings
        .prompts
        .plan
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(DEFAULT_PLAN_TEMPLATE);
    let header = task_header(task);
    let answers = answers_block(task);
    format!(
        "{}\n\n{READ_ONLY_NOTE}{}",
        render(template, &[("task", &header), ("answers", &answers)]),
        output_instructions::<PlanOut>()
    )
}

pub fn plan_revision(task: &Task, feedback: &str) -> String {
    format!(
        "You are an AI planning assistant. Revise the implementation plan below according to the \
         user's feedback. Keep what the feedback does not touch.\n\n{}\n\
         # Current plan\n\n{}\n\n# The user's feedback\n\n{}\n\n{READ_ONLY_NOTE}{}",
        task_header(task),
        task.planning.plan.as_deref().unwrap_or("(no plan yet)"),
        feedback.trim(),
        output_instructions::<PlanOut>()
    )
}

/// The editable part of the subtask prompt; a custom template from settings replaces it.
pub const DEFAULT_SUBTASKS_TEMPLATE: &str = "You are an AI development assistant. Break the \
approved plan below into subtasks that can be done one after another.

{{task}}
# Approved plan

{{plan}}

# Subtasks

- 3 to 15 `dev` subtasks, in the order they must be done, each small enough to finish in one \
sitting and specific about files, functions and changes.
- 1 to 4 `qa` subtasks that only verify the result: run the tests and the build, try the \
behaviour, compare the code with the plan. QA subtasks never change code; if something must be \
fixed, it belongs in a dev subtask.
- For a check that needs a person (UI, visual review), write a `qa` subtask whose detail says \
\"Manual check:\" and lists what the person should look at.
- Give each a short title (3 to 6 words), a detailed `detail`, and optionally a present-tense \
`progressLabel` (\"Adding validation\").";

pub fn subtasks(task: &Task, settings: &Settings) -> String {
    let template = settings
        .prompts
        .subtasks
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(DEFAULT_SUBTASKS_TEMPLATE);
    let header = task_header(task);
    let plan = task.planning.plan.clone().unwrap_or_default();
    format!(
        "{}\n\n{READ_ONLY_NOTE}{}",
        render(template, &[("task", &header), ("plan", &plan)]),
        output_instructions::<SubtasksOut>()
    )
}

/// The subtask list as the agent sees it, with the current one marked.
fn subtask_list(task: &Task, current: &str) -> String {
    let mut s = String::new();
    for sub in task.subtasks.iter().filter(|s| s.kind == SubtaskKind::Dev) {
        let mark = if sub.id == current {
            "→ (this one)"
        } else {
            match sub.status {
                SubtaskStatus::Done => "✓ done",
                SubtaskStatus::Skipped => "– skipped",
                SubtaskStatus::Pending => "  to do",
            }
        };
        let _ = writeln!(s, "- [{mark}] {}: {}", sub.id, sub.title);
    }
    s
}

fn handoffs(task: &Task) -> String {
    let notes: Vec<_> = task
        .subtasks
        .iter()
        .filter(|s| s.status == SubtaskStatus::Done)
        .filter_map(|s| s.handoff.as_ref().map(|h| (s, h)))
        .filter(|(_, h)| !h.trim().is_empty())
        .collect();
    if notes.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n# Notes from earlier subtasks\n\n");
    for (sub, note) in notes {
        let _ = writeln!(s, "- {} ({}): {}", sub.id, sub.title, note.trim());
    }
    s
}

/// The uncommitted work in each of a task's worktrees since its last checkpoint, by repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoDiffs(pub Vec<(String, WorkingDiff)>);

impl RepoDiffs {
    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|(_, d)| d.is_empty())
    }
}

/// The partial work an interrupted attempt left in the worktree (or, in a workspace, in each
/// repository's worktree).
pub fn diff_block(diffs: &RepoDiffs) -> String {
    match diffs.0.as_slice() {
        [(repo, diff)] if repo == ROOT_REPO => one_diff_block(diff, "the worktree"),
        all => {
            if diffs.is_empty() {
                return "No repository has changes since its last checkpoint.".into();
            }
            let mut s = String::new();
            for (repo, diff) in all.iter().filter(|(_, d)| !d.is_empty()) {
                let _ = write!(
                    s,
                    "\n## In {repo}/\n\n{}\n",
                    one_diff_block(diff, &format!("{repo}/"))
                );
            }
            s
        }
    }
}

fn one_diff_block(diff: &WorkingDiff, place: &str) -> String {
    if diff.is_empty() {
        return format!(
            "{} has no changes since the last checkpoint.",
            capitalize(place)
        );
    }
    let mut s = format!(
        "These changes are in {place} since the last checkpoint (the previous attempt's \
         work). Build on them; do not start over unless they are wrong.\n",
    );
    if !diff.diff.is_empty() {
        let _ = write!(s, "\n```diff\n{}\n```\n", diff.diff.trim_end());
    }
    if !diff.untracked.is_empty() {
        s.push_str("\nNew files not yet committed:\n");
        for f in &diff.untracked {
            let _ = writeln!(s, "- {f}");
        }
    }
    if diff.truncated {
        let _ = writeln!(
            s,
            "\n(The list above is cut short; run `git status` and `git diff` in {place} to see all \
             of it.)"
        );
    }
    s
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A dev subtask, with everything the agent needs. `resume` carries the partial work when a
/// previous attempt was interrupted and this is a fresh session.
pub fn dev(task: &Task, subtask: &Subtask, resume: Option<&RepoDiffs>) -> String {
    let mut s = format!(
        "You are a developer working through an approved plan one subtask at a time.\n\n{}\n\
         # Approved plan\n\n{}\n\n# Subtasks\n\n{}{}\n\
         # Your subtask: {} ({})\n\n{}\n",
        task_header(task),
        task.planning.plan.as_deref().unwrap_or("(no plan)"),
        subtask_list(task, &subtask.id),
        handoffs(task),
        subtask.title,
        subtask.id,
        subtask.detail.trim(),
    );
    if let Some(round) = subtask.rework_round {
        let _ = write!(
            s,
            "\nThis is rework round {round}: the work was checked and the problems above must be \
             fixed. Fix them without undoing the rest.\n"
        );
    }
    if let Some(diff) = resume {
        let _ = write!(
            s,
            "\n# Resuming an interrupted attempt\n\n{}\n",
            diff_block(diff)
        );
    }
    s.push_str(
        "\nDo only this subtask; later subtasks will be done after it. Do not commit: the \
         system commits your work when the subtask is done. In `handoff`, write what the next \
         subtasks must know (decisions, unfinished edges, where things live); leave it empty if \
         there is nothing.",
    );
    s.push_str(&output_instructions::<DevOut>());
    s
}

/// Continue the same provider session after an interruption.
pub fn resume_same_session(diff: &RepoDiffs) -> String {
    format!(
        "You were interrupted before finishing this subtask (the app was closed or paused). \
         Continue the same subtask from where you stopped.\n\n{}\n\n\
         Do not redo work that is already there.{}",
        diff_block(diff),
        output_instructions::<DevOut>()
    )
}

pub fn qa(task: &Task, subtask: &Subtask) -> String {
    let done: String = task
        .subtasks
        .iter()
        .filter(|s| s.kind == SubtaskKind::Dev && s.status == SubtaskStatus::Done)
        .map(|s| {
            let summary = s.handoff.as_deref().unwrap_or("");
            format!("- {}: {} {}\n", s.id, s.title, summary)
        })
        .collect();
    format!(
        "You are a QA reviewer. Verify the work below; you do not fix it.\n\n{}\n\
         # Approved plan\n\n{}\n\n# Dev work done\n\n{}\n\
         # Your check: {} ({})\n\n{}\n\n\
         You may read code and run commands (tests, the build, the app), but do not edit, create \
         or delete files: anything you change is discarded, and fixes are made in a separate dev \
         step. Check that the code does what the plan says, look for errors and runtime problems, \
         and report each problem found as one concrete finding (what, where, how to see it). \
         `passed` is true only if there is nothing that must be fixed. If the check needs a person, \
         say so in the summary and list what they should look at as findings, with `passed` true.{}",
        task_header(task),
        task.planning.plan.as_deref().unwrap_or("(no plan)"),
        if done.is_empty() {
            "(none)\n".to_string()
        } else {
            done
        },
        subtask.title,
        subtask.id,
        subtask.detail.trim(),
        output_instructions::<QaOut>()
    )
}

pub fn triage(task: &Task, subtask: &Subtask, diff: &RepoDiffs) -> String {
    format!(
        "A developer was interrupted while working on a subtask. Judge the state they left; do \
         not change anything.\n\n{}\n# The subtask: {} ({})\n\n{}\n\n# What is in the \
         worktree\n\n{}\n\n\
         Answer `done` if the subtask is complete as it stands, `partial` if it is part-way and \
         the changes are a good base, or `broken` if the changes should be thrown away and the \
         subtask redone.{}",
        task_header(task),
        subtask.title,
        subtask.id,
        subtask.detail.trim(),
        diff_block(diff),
        output_instructions::<TriageOut>()
    )
}

/// Follow-up in the same session when the answer could not be read.
pub fn repair<T: AgentOutput>(error: &str) -> String {
    format!(
        "Your answer could not be used: {error}\n\nReply again with only the corrected JSON \
         object, nothing else.{}",
        output_instructions::<T>()
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::task::{AgentConfig, Provider};

    fn task() -> Task {
        let mut t = Task::new(
            "Add pagination",
            "Page the list",
            AgentConfig::new(Provider::Mock),
        );
        t.planning.plan = Some("# Plan\n\n## Steps\n1. a\n2. b".into());
        let mut d1 = Subtask::new("dev-1", SubtaskKind::Dev, "Cursor query", "Add a cursor");
        d1.status = SubtaskStatus::Done;
        d1.finished_at = Some(1);
        d1.handoff = Some("Cursor is base64 of the id.".into());
        let d2 = Subtask::new("dev-2", SubtaskKind::Dev, "Return next", "Return next");
        let q1 = Subtask::new("qa-1", SubtaskKind::Qa, "Test paging", "Check pages");
        t.subtasks = vec![d1, d2, q1];
        t
    }

    #[test]
    fn render_replaces_known_placeholders_only() {
        assert_eq!(render("a {{x}} {{y}}", &[("x", "1")]), "a 1 {{y}}");
        assert_eq!(render("unclosed {{x", &[("x", "1")]), "unclosed {{x");
    }

    #[test]
    fn inserted_values_are_not_rendered_again() {
        let out = render(
            "{{task}} / {{plan}}",
            &[("task", "mentions {{plan}}"), ("plan", "THE PLAN")],
        );
        assert_eq!(out, "mentions {{plan}} / THE PLAN");
    }

    #[test]
    fn a_dev_prompt_carries_plan_list_handoffs_and_answer_format() {
        let t = task();
        let p = dev(&t, &t.subtasks[1], None);
        assert!(p.contains("## Steps"), "plan missing");
        assert!(p.contains("[✓ done] dev-1"));
        assert!(p.contains("[→ (this one)] dev-2"));
        assert!(p.contains("Cursor is base64 of the id."), "handoff missing");
        assert!(p.contains("\"handoff\""), "answer format missing");
        assert!(!p.contains("Resuming"));
    }

    #[test]
    fn a_resumed_dev_prompt_shows_the_partial_work() {
        let t = task();
        let diff = WorkingDiff {
            base: "abc".into(),
            diff: "+fn next() {}".into(),
            untracked: vec!["src/new.rs".into()],
            truncated: false,
        };
        let diff = RepoDiffs(vec![(ROOT_REPO.to_string(), diff)]);
        let p = dev(&t, &t.subtasks[1], Some(&diff));
        assert!(p.contains("Resuming an interrupted attempt"));
        assert!(p.contains("+fn next() {}"));
        assert!(p.contains("src/new.rs"));
        assert!(resume_same_session(&diff).contains("+fn next() {}"));
    }

    #[test]
    fn custom_templates_replace_only_the_editable_part() {
        let mut settings = Settings::default();
        settings.prompts.plan = Some("CUSTOM for {{task}}".into());
        let p = plan(&task(), &settings);
        assert!(p.starts_with("CUSTOM for **Task:** Add pagination"));
        assert!(
            p.contains("# Answer format"),
            "the engine's instructions must still follow"
        );
    }

    #[test]
    fn qa_prompts_forbid_edits_and_ask_for_a_verdict() {
        let t = task();
        let p = qa(&t, &t.subtasks[2]);
        assert!(p.contains("do not edit"));
        assert!(p.contains("\"passed\""));
        assert!(p.contains("dev-1: Cursor query"));
    }
}
