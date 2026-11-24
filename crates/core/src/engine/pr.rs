//! Opening the pull request for a reviewed task, or bringing an open one up to date.
//!
//! The task's checkpoint commits are squashed into one commit on top of its base commit, and the
//! branch is pushed (with `--force-with-lease`, since squashing rewrites it). The first time,
//! `gh pr create` opens the PR against the main branch; afterwards (rework done after the PR was
//! opened) only the squash and push happen. If `gh` fails after the push, the PR it may still have
//! created is looked up with `gh pr view`, so a retry never trips over "already exists".

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::Inner;
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{Phase, PullRequest, SubtaskKind, SubtaskStatus, Task};

const NETWORK: Duration = Duration::from_secs(90);

pub(crate) async fn create(inner: &Inner, id: &str) -> Result<String> {
    let task = inner
        .store
        .load(id)
        .await?
        .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
    if !matches!(task.phase, Phase::HumanReview | Phase::Done) {
        return Err(CoreError::Invalid(
            "a pull request is opened from human review".into(),
        ));
    }
    let base = task
        .base_commit
        .clone()
        .ok_or_else(|| CoreError::Invalid("the task has no worktree".into()))?;
    // Located before anything changes, so a missing gh fails cleanly.
    let gh = inner.bins.locate_tool("gh")?;
    let wt = inner.worktrees.path_for(id)?;
    let branch = Worktrees::branch_for(id);

    let mut message = task.title.clone();
    if !task.description.trim().is_empty() {
        message.push_str("\n\n");
        message.push_str(task.description.trim());
    }
    message.push_str(&format!("\n\nCode-Automata task {id}"));
    if git::squash_checkpoints(&wt, &base, &message)
        .await?
        .is_none()
    {
        return Err(CoreError::Invalid(
            "nothing to open a pull request for: the task's changes add up to no change".into(),
        ));
    }

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

    if let Some(pr) = &task.pull_request {
        // Already open: the push updated the code; bring the description up to date too.
        if let Err(e) = gh_output(
            inner,
            &gh,
            &wt,
            &["pr", "edit", &pr.url, "--body", &body(&task)],
        )
        .await
        {
            inner.emit(super::EngineEvent::Error {
                task_id: id.to_string(),
                message: format!(
                    "the pull request's code was updated but its description was not: {e}"
                ),
            });
        }
        return Ok(pr.url.clone());
    }
    let url = match existing_pr(inner, &gh, &wt, &branch).await {
        Some(url) => url,
        None => match open_pr(inner, &gh, &wt, &branch, &task).await {
            Ok(url) => url,
            // It may have been created even though the call failed (a timeout, no URL printed).
            Err(e) => existing_pr(inner, &gh, &wt, &branch).await.ok_or(e)?,
        },
    };
    inner
        .update(id, |t| {
            t.pull_request = Some(PullRequest { url: url.clone() });
            Ok(())
        })
        .await?;
    Ok(url)
}

fn body(task: &Task) -> String {
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
    // Set only when review ended with checks or QA still failing.
    if let Some(feedback) = &task.review.feedback {
        body.push_str(&format!("\n## Unresolved review findings\n\n{feedback}\n"));
    }
    body.push_str("\nOpened by Code-Automata.\n");
    body
}

async fn gh_output(inner: &Inner, gh: &PathBuf, wt: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = crate::proc::command(gh);
    cmd.args(args)
        .current_dir(wt)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(p) = inner.bins.path_var() {
        cmd.env("PATH", p);
    }
    let out = tokio::time::timeout(NETWORK, cmd.output())
        .await
        .map_err(|_| CoreError::Invalid(format!("`gh {}` timed out", args[..2].join(" "))))?
        .map_err(|e| CoreError::Invalid(format!("could not run gh: {e}")))?;
    if !out.status.success() {
        return Err(CoreError::Invalid(format!(
            "`gh {}` failed: {}",
            args[..2].join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn first_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| w.starts_with("https://"))
        .map(String::from)
}

/// The URL of an open PR for `branch`, if there is one. A closed or merged one does not count.
async fn existing_pr(inner: &Inner, gh: &PathBuf, wt: &Path, branch: &str) -> Option<String> {
    let out = gh_output(
        inner,
        gh,
        wt,
        &[
            "pr",
            "view",
            branch,
            "--json",
            "url,state",
            "--jq",
            r#"select(.state == "OPEN") | .url"#,
        ],
    )
    .await
    .ok()?;
    first_url(&out)
}

async fn open_pr(
    inner: &Inner,
    gh: &PathBuf,
    wt: &Path,
    branch: &str,
    task: &Task,
) -> Result<String> {
    let main = inner.worktrees.main_branch().await;
    let body = body(task);
    let out = gh_output(
        inner,
        gh,
        wt,
        &[
            "pr",
            "create",
            "--title",
            &task.title,
            "--body",
            &body,
            "--base",
            &main,
            "--head",
            branch,
        ],
    )
    .await?;
    first_url(&out).ok_or_else(|| CoreError::Invalid(format!("gh printed no PR URL: {out}")))
}
