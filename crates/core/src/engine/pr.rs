//! Opening the pull request for a reviewed task.
//!
//! The task's checkpoint commits are squashed into one commit on top of its base commit. The branch
//! is pushed (with `--force-with-lease`, since squashing rewrote it), and `gh pr create` opens the
//! PR against the main branch. The URL is stored on the task; asking again returns it.

use std::time::Duration;

use super::Inner;
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{Phase, PullRequest, SubtaskKind, SubtaskStatus};

const NETWORK: Duration = Duration::from_secs(90);

pub(crate) async fn create(inner: &Inner, id: &str) -> Result<String> {
    let task = inner
        .store
        .load(id)
        .await?
        .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
    if let Some(pr) = &task.pull_request {
        return Ok(pr.url.clone());
    }
    if !matches!(task.phase, Phase::HumanReview | Phase::Done) {
        return Err(CoreError::Invalid(
            "a pull request is opened from human review".into(),
        ));
    }
    let base = task
        .base_commit
        .clone()
        .ok_or_else(|| CoreError::Invalid("the task has no worktree".into()))?;
    let wt = inner.worktrees.path_for(id)?;
    let branch = Worktrees::branch_for(id);

    let mut message = task.title.clone();
    if !task.description.trim().is_empty() {
        message.push_str("\n\n");
        message.push_str(task.description.trim());
    }
    message.push_str(&format!("\n\nCode-Automata task {id}"));
    git::squash_checkpoints(&wt, &base, &message).await?;

    git::run_git_timeout(
        &wt,
        &[
            "push",
            "--force-with-lease",
            "-u",
            "origin",
            &format!("HEAD:refs/heads/{branch}"),
        ],
        NETWORK,
    )
    .await?;

    let mut body = String::new();
    if !task.description.trim().is_empty() {
        body.push_str(task.description.trim());
        body.push_str("\n\n");
    }
    body.push_str("## Done\n\n");
    for s in task
        .subtasks_of(SubtaskKind::Dev)
        .filter(|s| s.status == SubtaskStatus::Done)
    {
        body.push_str(&format!("- {}\n", s.title));
    }
    if let Some(feedback) = &task.review.feedback {
        body.push_str(&format!("\n## Unresolved review findings\n\n{feedback}\n"));
    }
    body.push_str("\nOpened by Code-Automata.\n");

    let gh = inner.bins.locate_tool("gh")?;
    let main = inner.worktrees.main_branch().await;
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args([
        "pr",
        "create",
        "--title",
        &task.title,
        "--body",
        &body,
        "--base",
        &main,
        "--head",
        &branch,
    ])
    .current_dir(&wt)
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    if let Some(p) = inner.bins.path_var() {
        cmd.env("PATH", p);
    }
    let out = tokio::time::timeout(NETWORK, cmd.output())
        .await
        .map_err(|_| CoreError::Invalid("`gh pr create` timed out".into()))?
        .map_err(|e| CoreError::Invalid(format!("could not run gh: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(CoreError::Invalid(format!(
            "`gh pr create` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let url = stdout
        .split_whitespace()
        .find(|w| w.starts_with("https://"))
        .ok_or_else(|| CoreError::Invalid(format!("gh printed no PR URL: {stdout}")))?
        .to_string();
    inner
        .update(id, |t| {
            t.pull_request = Some(PullRequest { url: url.clone() });
            Ok(())
        })
        .await?;
    Ok(url)
}
