//! The coordinator: what a task does next, decided from its state alone.
//!
//! [`next_step`] is a pure function of the task and settings: no I/O, no clock, no memory of what
//! ran before. Restarting the app, resuming, or running the same task twice therefore always
//! arrives at the same next step. The driver executes the step, writes its result, and asks again.
//!
//! The pure helpers at the bottom ([`apply_rework`], [`apply_finish_review`]) are the task edits a
//! step makes, kept here so the rules are tested in one place.

use crate::error::Result;
use crate::task::{Phase, PlanningStage, Subtask, SubtaskKind, SubtaskStatus, Task};
use crate::transitions::{Mover, apply_move};

use super::settings::Settings;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Nothing to do until the user acts.
    Wait(Waiting),
    /// The run is paused, interrupted or failed; only `resume` continues it.
    Halted,
    /// Create the task's worktree and record its base commit.
    CreateWorktree,
    /// Run an agent.
    Agent(AgentStep),
    /// Approve the plan without asking (plan approval is off).
    AutoApprove,
    /// Move to the next column (the engine's own move).
    Move(Phase),
    RunChecks,
    /// Add a rework subtask from the failures and go back to in_progress.
    Rework(ReworkCause),
    /// Move to human review, with any unresolved findings attached.
    FinishReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStep {
    Questions,
    Plan,
    Subtasks,
    Dev(String),
    Qa(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    Answers,
    Approval,
    HumanReview,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReworkCause {
    Checks,
    Qa,
}

pub fn next_step(task: &Task, settings: &Settings) -> Step {
    if task.run.as_ref().is_some_and(|r| r.state.is_resumable()) {
        return Step::Halted;
    }
    match task.phase {
        Phase::Planning => {
            if !task.has_worktrees() {
                return Step::CreateWorktree;
            }
            match task.planning.stage {
                PlanningStage::NotStarted if task.require_plan_approval => {
                    Step::Agent(AgentStep::Questions)
                }
                PlanningStage::NotStarted | PlanningStage::Answered => Step::Agent(AgentStep::Plan),
                // Plan approval switched off while questions waited: they become optional.
                PlanningStage::Questions if !task.require_plan_approval => {
                    Step::Agent(AgentStep::Plan)
                }
                PlanningStage::Questions => Step::Wait(Waiting::Answers),
                PlanningStage::PlanReady if task.planning.revision.is_some() => {
                    Step::Agent(AgentStep::Plan)
                }
                PlanningStage::PlanReady if task.require_plan_approval || task.planning.hold => {
                    Step::Wait(Waiting::Approval)
                }
                PlanningStage::PlanReady => Step::AutoApprove,
                PlanningStage::Approved if task.subtasks.is_empty() => {
                    Step::Agent(AgentStep::Subtasks)
                }
                PlanningStage::Approved => Step::Move(Phase::InProgress),
            }
        }
        Phase::InProgress => match first_pending(task, SubtaskKind::Dev) {
            Some(id) => Step::Agent(AgentStep::Dev(id)),
            None => Step::Move(Phase::AiReview),
        },
        Phase::AiReview => {
            if !checks_are_current(task) {
                return Step::RunChecks;
            }
            let rework_left = task.review.rework_count < settings.rework_limit;
            if task.checks_failed() {
                return if rework_left {
                    Step::Rework(ReworkCause::Checks)
                } else {
                    Step::FinishReview
                };
            }
            if let Some(id) = first_pending(task, SubtaskKind::Qa) {
                return Step::Agent(AgentStep::Qa(id));
            }
            if failed_qa(task).next().is_some() && rework_left {
                return Step::Rework(ReworkCause::Qa);
            }
            Step::FinishReview
        }
        Phase::HumanReview => Step::Wait(Waiting::HumanReview),
        Phase::Done => Step::Wait(Waiting::Done),
    }
}

fn first_pending(task: &Task, kind: SubtaskKind) -> Option<String> {
    task.subtasks_of(kind)
        .find(|s| s.status == SubtaskStatus::Pending)
        .map(|s| s.id.clone())
}

/// Checks are current when every repository that counts has checks run against its last dev
/// checkpoint. Commits, not clock times: a clock that steps back cannot make them look stale
/// forever. A workspace task that changed nothing has nothing to check.
fn checks_are_current(task: &Task) -> bool {
    task.repos_to_check().iter().all(|repo| {
        match (
            task.review.checks.get(*repo),
            task.last_dev_checkpoint(repo),
        ) {
            (Some(checks), Some(commit)) => checks.commit == commit,
            _ => false,
        }
    })
}

fn failed_qa(task: &Task) -> impl Iterator<Item = &Subtask> {
    task.subtasks_of(SubtaskKind::Qa)
        .filter(|s| s.verdict.as_ref().is_some_and(|v| !v.passed))
}

/// What a rework round has to fix, from the failing checks or QA verdicts.
pub fn rework_feedback(task: &Task, cause: ReworkCause) -> String {
    match cause {
        ReworkCause::Checks => {
            let failed: Vec<_> = task
                .repos_to_check()
                .into_iter()
                .filter_map(|r| task.review.checks.get(r).map(|c| (r, c)))
                .filter(|(_, c)| !c.passed)
                .collect();
            match failed.as_slice() {
                [(crate::util::ROOT_REPO, c)] => format!(
                    "The automated checks failed ({}). Fix the cause of each failure:\n\n{}",
                    c.summary,
                    c.details.as_deref().unwrap_or("")
                ),
                _ => {
                    let mut s = String::from(
                        "The automated checks failed. Fix the cause of each failure:\n",
                    );
                    for (repo, c) in failed {
                        s.push_str(&format!(
                            "\n## In {repo}/ ({})\n\n{}\n",
                            c.summary,
                            c.details.as_deref().unwrap_or("")
                        ));
                    }
                    s
                }
            }
        }
        ReworkCause::Qa => {
            let mut s = String::from("QA review found problems. Fix each finding:\n");
            for sub in failed_qa(task) {
                if let Some(v) = &sub.verdict {
                    s.push_str(&format!(
                        "\n## {} ({})\n\n{}\n",
                        sub.title, sub.id, v.summary
                    ));
                    for f in &v.findings {
                        s.push_str(&format!("- {f}\n"));
                    }
                }
            }
            s
        }
    }
}

/// Start an automatic rework round from failing checks or QA. See [`add_rework`].
pub fn apply_rework(task: &mut Task, cause: ReworkCause, settings: &Settings) -> Result<String> {
    let feedback = rework_feedback(task, cause);
    add_rework(task, feedback, settings)
}

/// A rework the user asked for from review, with what to fix. It starts a fresh budget of
/// automatic rework rounds.
pub fn apply_user_rework(task: &mut Task, feedback: &str, settings: &Settings) -> Result<String> {
    if !matches!(task.phase, Phase::AiReview | Phase::HumanReview) {
        return Err(crate::error::CoreError::Invalid(
            "rework can be requested from AI review or human review".into(),
        ));
    }
    if task.has_active_run() {
        return Err(crate::error::CoreError::Invalid(
            "pause the task before requesting rework".into(),
        ));
    }
    if feedback.trim().is_empty() {
        return Err(crate::error::CoreError::Invalid(
            "say what should be fixed".into(),
        ));
    }
    task.review.rework_count = 0;
    add_rework(
        task,
        format!(
            "The reviewer asked for these changes:\n\n{}",
            feedback.trim()
        ),
        settings,
    )
}

/// Add a rework dev subtask carrying `feedback`, reset the QA that ran (or that the engine skipped)
/// so it runs again on the fixed code, and move back to in_progress. QA the user skipped stays
/// skipped. The caller sets the next run in the same update.
fn add_rework(task: &mut Task, feedback: String, settings: &Settings) -> Result<String> {
    let round = task.review.rework_count + 1;
    let mut id = format!("rework-{round}");
    let mut n = 1;
    while task.subtask(&id).is_some() {
        n += 1;
        id = format!("rework-{round}-{n}");
    }
    let label = format!("Reworking ({round}/{})", settings.rework_limit);
    let mut sub = Subtask::new(&id, SubtaskKind::Dev, label.clone(), feedback.clone());
    sub.progress_label = Some(label);
    sub.rework_round = Some(round);
    // Rework goes after the last dev subtask, before the QA subtasks.
    let at = task
        .subtasks
        .iter()
        .rposition(|s| s.kind == SubtaskKind::Dev)
        .map_or(0, |i| i + 1);
    task.subtasks.insert(at, sub);
    for qa in task.subtasks.iter_mut().filter(|s| {
        s.kind == SubtaskKind::Qa && (s.status == SubtaskStatus::Done || s.skipped_reason.is_some())
    }) {
        qa.status = SubtaskStatus::Pending;
        qa.verdict = None;
        qa.finished_at = None;
        qa.checkpoints.clear();
        qa.skipped_reason = None;
    }
    task.review.rework_count = round;
    task.review.feedback = Some(feedback);
    task.run = None;
    apply_move(task, Phase::InProgress, Mover::Engine)?;
    Ok(id)
}

/// Finish AI review. When the rework limit ran out with checks still failing, the QA subtasks never
/// ran; they are marked skipped and the failure stays in `review` for the human reviewer.
pub fn apply_finish_review(task: &mut Task) -> Result<()> {
    let checks_failed = task.checks_failed();
    let qa_failed = failed_qa(task).next().is_some();
    if !checks_failed && !qa_failed {
        // Earlier rounds' findings are resolved; nothing is left for the reviewer.
        task.review.feedback = None;
    } else {
        let cause = if checks_failed {
            ReworkCause::Checks
        } else {
            ReworkCause::Qa
        };
        task.review.feedback = Some(format!(
            "Unresolved after {} rework round(s):\n\n{}",
            task.review.rework_count,
            rework_feedback(task, cause)
        ));
    }
    let now = crate::util::now_ms();
    for qa in task
        .subtasks
        .iter_mut()
        .filter(|s| s.kind == SubtaskKind::Qa && s.status == SubtaskStatus::Pending)
    {
        qa.status = SubtaskStatus::Skipped;
        qa.finished_at = Some(now);
        qa.skipped_reason = Some("not run: the checks were still failing".into());
    }
    task.run = None;
    apply_move(task, Phase::HumanReview, Mover::Engine)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::task::{AgentConfig, Checks, Provider, QaVerdict, Run, RunKind, RunState};
    use crate::util::ROOT_REPO;
    use std::collections::BTreeMap;

    fn settings() -> Settings {
        Settings::default()
    }

    fn base() -> Task {
        let mut t = Task::new("t", "", AgentConfig::new(Provider::Mock));
        t.base_commits.insert(ROOT_REPO.into(), "abc".into());
        t
    }

    fn sub(id: &str, kind: SubtaskKind, status: SubtaskStatus, finished: Option<i64>) -> Subtask {
        let mut s = Subtask::new(id, kind, id, id);
        s.status = status;
        s.finished_at = finished;
        s
    }

    fn with_phase(mut t: Task, phase: Phase) -> Task {
        t.phase = phase;
        t.planning.stage = PlanningStage::Approved;
        t
    }

    /// Checks that ran against `commit`.
    fn checks(passed: bool, commit: &str) -> BTreeMap<String, Checks> {
        let checks = Checks {
            passed,
            summary: if passed {
                "✓ build".into()
            } else {
                "✗ build".into()
            },
            details: (!passed).then(|| "error at x".into()),
            at: 0,
            commit: commit.into(),
        };
        BTreeMap::from([(ROOT_REPO.to_string(), checks)])
    }

    fn done_dev(id: &str, checkpoint: &str) -> Subtask {
        let mut s = sub(id, SubtaskKind::Dev, SubtaskStatus::Done, Some(1));
        s.checkpoints.insert(ROOT_REPO.into(), checkpoint.into());
        s
    }

    fn verdict(passed: bool) -> Option<QaVerdict> {
        Some(QaVerdict {
            passed,
            summary: "s".into(),
            findings: if passed {
                vec![]
            } else {
                vec!["broken thing".into()]
            },
        })
    }

    #[test]
    fn planning_steps() {
        let s = settings();
        let mut t = Task::new("t", "", AgentConfig::new(Provider::Mock));
        assert_eq!(next_step(&t, &s), Step::CreateWorktree);
        t.base_commits.insert(ROOT_REPO.into(), "abc".into());
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Plan));
        t.require_plan_approval = true;
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Questions));
        t.planning.stage = PlanningStage::Questions;
        assert_eq!(next_step(&t, &s), Step::Wait(Waiting::Answers));
        t.planning.stage = PlanningStage::Answered;
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Plan));
        t.planning.stage = PlanningStage::PlanReady;
        assert_eq!(next_step(&t, &s), Step::Wait(Waiting::Approval));
        t.planning.revision = Some("use a cursor".into());
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Plan));
        t.planning.revision = None;
        t.require_plan_approval = false;
        assert_eq!(next_step(&t, &s), Step::AutoApprove);
        t.planning.stage = PlanningStage::Approved;
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Subtasks));
        t.subtasks
            .push(sub("dev-1", SubtaskKind::Dev, SubtaskStatus::Pending, None));
        assert_eq!(next_step(&t, &s), Step::Move(Phase::InProgress));
    }

    #[test]
    fn dev_steps_run_pending_subtasks_in_order() {
        let s = settings();
        let mut t = with_phase(base(), Phase::InProgress);
        t.subtasks = vec![
            sub("dev-1", SubtaskKind::Dev, SubtaskStatus::Done, Some(1)),
            sub("dev-2", SubtaskKind::Dev, SubtaskStatus::Skipped, Some(2)),
            sub("dev-3", SubtaskKind::Dev, SubtaskStatus::Pending, None),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        assert_eq!(
            next_step(&t, &s),
            Step::Agent(AgentStep::Dev("dev-3".into()))
        );
        t.subtasks[2].status = SubtaskStatus::Done;
        t.subtasks[2].finished_at = Some(3);
        assert_eq!(next_step(&t, &s), Step::Move(Phase::AiReview));
    }

    #[test]
    fn a_halted_run_stops_everything() {
        let s = settings();
        let mut t = with_phase(base(), Phase::InProgress);
        t.subtasks = vec![sub("dev-1", SubtaskKind::Dev, SubtaskStatus::Pending, None)];
        for state in [
            RunState::Paused,
            RunState::Interrupted,
            RunState::Failed,
            RunState::RateLimited,
        ] {
            t.run = Some(Run::new(RunKind::Dev, state, Some("dev-1".into())));
            assert_eq!(next_step(&t, &s), Step::Halted, "{state:?}");
        }
        t.run.as_mut().unwrap().state = RunState::Done;
        assert_eq!(
            next_step(&t, &s),
            Step::Agent(AgentStep::Dev("dev-1".into()))
        );
    }

    #[test]
    fn review_runs_checks_first_then_qa() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
            sub("qa-2", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        assert_eq!(next_step(&t, &s), Step::RunChecks);
        t.review.checks = checks(true, "c0"); // ran against an older commit
        assert_eq!(next_step(&t, &s), Step::RunChecks);
        t.review.checks = checks(true, "c1");
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Qa("qa-1".into())));
        t.subtasks[1].status = SubtaskStatus::Done;
        t.subtasks[1].verdict = verdict(true);
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Qa("qa-2".into())));
        t.subtasks[2].status = SubtaskStatus::Done;
        t.subtasks[2].verdict = verdict(true);
        assert_eq!(next_step(&t, &s), Step::FinishReview);
    }

    #[test]
    fn failures_rework_until_the_limit() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        t.review.checks = checks(false, "c1");
        assert_eq!(next_step(&t, &s), Step::Rework(ReworkCause::Checks));
        t.review.rework_count = 2;
        assert_eq!(next_step(&t, &s), Step::FinishReview);

        // QA: all QA runs first, then one rework for every failed verdict.
        t.review.rework_count = 0;
        t.review.checks = checks(true, "c1");
        t.subtasks
            .push(sub("qa-2", SubtaskKind::Qa, SubtaskStatus::Pending, None));
        t.subtasks[1].status = SubtaskStatus::Done;
        t.subtasks[1].verdict = verdict(false);
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Qa("qa-2".into())));
        t.subtasks[2].status = SubtaskStatus::Done;
        t.subtasks[2].verdict = verdict(true);
        assert_eq!(next_step(&t, &s), Step::Rework(ReworkCause::Qa));
        t.review.rework_count = 2;
        assert_eq!(next_step(&t, &s), Step::FinishReview);
    }

    #[test]
    fn a_rework_round_adds_a_labelled_subtask_and_resets_qa() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Done, Some(30)),
            sub(
                "qa-user-skipped",
                SubtaskKind::Qa,
                SubtaskStatus::Skipped,
                Some(31),
            ),
        ];
        t.subtasks[1].verdict = verdict(false);
        t.review.checks = checks(true, "c1");

        let id = apply_rework(&mut t, ReworkCause::Qa, &s).unwrap();
        assert_eq!(id, "rework-1");
        assert_eq!(t.phase, Phase::InProgress);
        assert_eq!(t.review.rework_count, 1);
        let rework = t.subtask("rework-1").unwrap();
        assert_eq!(rework.title, "Reworking (1/2)");
        assert_eq!(rework.rework_round, Some(1));
        assert!(rework.detail.contains("broken thing"));
        assert_eq!(t.subtasks[1].id, "rework-1", "rework goes before QA");
        let qa = t.subtask("qa-1").unwrap();
        assert_eq!(qa.status, SubtaskStatus::Pending);
        assert!(qa.verdict.is_none());
        assert_eq!(
            t.subtask("qa-user-skipped").unwrap().status,
            SubtaskStatus::Skipped,
            "a user's skip must survive a rework round"
        );
        t.validate().unwrap();

        // Next: the rework subtask runs; after it, checks are stale again.
        assert_eq!(
            next_step(&t, &s),
            Step::Agent(AgentStep::Dev("rework-1".into()))
        );
    }

    #[test]
    fn finishing_with_failures_skips_unrun_qa_and_keeps_the_findings() {
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        t.review.checks = checks(false, "c1");
        t.review.rework_count = 2;
        apply_finish_review(&mut t).unwrap();
        assert_eq!(t.phase, Phase::HumanReview);
        assert_eq!(t.subtasks[1].status, SubtaskStatus::Skipped);
        assert!(
            t.subtasks[1].skipped_reason.is_some(),
            "engine skips are marked"
        );
        assert!(
            t.review
                .feedback
                .as_deref()
                .unwrap()
                .contains("Unresolved after 2")
        );
        t.validate().unwrap();
    }

    #[test]
    fn human_review_and_done_wait() {
        let s = settings();
        assert_eq!(
            next_step(&with_phase(base(), Phase::HumanReview), &s),
            Step::Wait(Waiting::HumanReview)
        );
        assert_eq!(
            next_step(&with_phase(base(), Phase::Done), &s),
            Step::Wait(Waiting::Done)
        );
    }

    #[test]
    fn a_clock_jump_cannot_keep_checks_stale() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        let mut dev = done_dev("dev-1", "c1");
        dev.finished_at = Some(i64::MAX); // finished "in the future"
        t.subtasks = vec![
            dev,
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        t.review.checks = checks(true, "c1");
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Qa("qa-1".into())));
    }

    #[test]
    fn questions_become_optional_when_approval_is_switched_off() {
        let s = settings();
        let mut t = base();
        t.planning.stage = PlanningStage::Questions;
        t.require_plan_approval = false;
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Plan));
    }

    #[test]
    fn replanning_waits_for_approval_and_is_not_undone() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Pending, None),
        ];
        t.planning.plan = Some("# P".into());
        apply_move(&mut t, Phase::Planning, Mover::User).unwrap();
        assert!(t.subtasks.is_empty());
        assert_eq!(t.planning.stage, PlanningStage::PlanReady);
        assert!(!t.require_plan_approval, "the user's setting is untouched");
        assert_eq!(
            next_step(&t, &s),
            Step::Wait(Waiting::Approval),
            "the engine must not move it straight back"
        );
        t.validate().unwrap();
    }

    #[test]
    fn a_rework_drag_needs_feedback_and_user_rework_is_not_undone() {
        let s = settings();
        let mut t = with_phase(base(), Phase::HumanReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Done, Some(2)),
        ];
        t.subtasks[1].verdict = verdict(true);
        t.review.rework_count = 2;
        assert!(apply_move(&mut t, Phase::InProgress, Mover::User).is_err());

        let id = apply_user_rework(&mut t, "Rename the endpoint", &s).unwrap();
        assert_eq!(t.phase, Phase::InProgress);
        assert_eq!(
            t.review.rework_count, 1,
            "a user rework starts a fresh budget"
        );
        assert!(
            t.subtask(&id)
                .unwrap()
                .detail
                .contains("Rename the endpoint")
        );
        assert_eq!(next_step(&t, &s), Step::Agent(AgentStep::Dev(id)));
        assert!(
            apply_user_rework(&mut t, "again", &s).is_err(),
            "only from review"
        );
        t.validate().unwrap();
    }

    #[test]
    fn a_passing_review_clears_old_findings() {
        let s = settings();
        let mut t = with_phase(base(), Phase::AiReview);
        t.subtasks = vec![
            done_dev("dev-1", "c1"),
            sub("qa-1", SubtaskKind::Qa, SubtaskStatus::Done, Some(2)),
        ];
        t.subtasks[1].verdict = verdict(false);
        t.review.checks = checks(true, "c1");
        apply_rework(&mut t, ReworkCause::Qa, &s).unwrap();
        assert!(t.review.feedback.is_some());
        // The rework fixed it: everything passes on the next round.
        t.phase = Phase::AiReview;
        let rework = t.subtask_mut("rework-1").unwrap();
        rework.status = SubtaskStatus::Done;
        rework.finished_at = Some(3);
        rework.checkpoints.insert(ROOT_REPO.into(), "c2".into());
        t.review.checks = checks(true, "c2");
        let qa = t.subtask_mut("qa-1").unwrap();
        qa.status = SubtaskStatus::Done;
        qa.finished_at = Some(4);
        qa.verdict = verdict(true);
        apply_finish_review(&mut t).unwrap();
        assert!(t.review.feedback.is_none());
    }
}
