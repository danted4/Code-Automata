//! Opening the pull request for a reviewed task, or bringing an open one up to date.
//!
//! The task's checkpoint commits are squashed into one commit on top of its base commit, and the
//! branch is pushed (with `--force-with-lease`, since squashing rewrites it). The repository's
//! pre-push hook runs, with the login shell's PATH (user decision, 2026-11-25).
//!
//! How the PR is opened depends on the host (`PrHost`): the project setting, else detected from
//! the `origin` URL (`detect_host`):
//!
//! - **GitHub** (github.com, or a host the GitHub CLI is logged in to): `gh pr create` against the
//!   main branch; afterwards only the squash, the push and `gh pr edit` for the description. If
//!   `gh` fails after the push, the PR it may still have created is looked up with `gh pr view`,
//!   so a retry never trips over "already exists".
//! - **GitLab** (gitlab.com, a host named like it, or the setting): no CLI. The first push carries
//!   push options (`merge_request.create` and friends, GitLab 11.10+), GitLab opens the merge
//!   request and prints its link, which is read from the push's output. A later push updates it.
//! - **Any other host**: the branch is pushed, and the "create a pull request" link most hosts
//!   print for a pushed branch (Bitbucket, Gitea, GitHub and GitLab do) is kept as the task's
//!   link. Without one, the branch is still pushed: the user opens the PR on the host.
//!
//! A replan keeps the PR: approving the new plan resets the worktree to the base commit, the new
//! run commits fresh checkpoints, and the next update squashes those and force-pushes them over
//! the old commit on the same branch.

use std::path::Path;
use std::time::Duration;

use super::Inner;
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{Phase, PrHost, PullRequest, SubtaskKind, SubtaskStatus, Task};

const NETWORK: Duration = Duration::from_secs(90);
/// Asking the GitHub CLI whether it knows a host reads its config; no network.
const GH_HOST_CHECK: Duration = Duration::from_secs(15);

pub(crate) async fn create(inner: &Inner, id: &str) -> Result<PullRequest> {
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
    let wt = inner.worktrees.path_for(id)?;
    if !inner.worktrees.status(id).await?.exists {
        return Err(CoreError::Invalid(
            "the task's worktree was removed; reopen the task to bring it back".into(),
        ));
    }
    let branch = Worktrees::branch_for(id);

    // Everything that can fail without changing anything comes first: the host, and gh for it.
    let host = pr_host(inner, &wt).await?;
    let gh = match host {
        PrHost::Github => Some(inner.bins.locate_tool("gh")?),
        PrHost::Gitlab | PrHost::Other => None,
    };

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

    // The newest work the pushed commit holds, for the UI's "up to date".
    let pushed_checkpoint = task.newest_dev_checkpoint().map(str::to_string);
    let previous = task.pull_request.clone();

    let (host, url) = match (host, gh) {
        (PrHost::Github, Some(gh)) => {
            push(&wt, &branch, &[]).await?;
            let url = github(inner, &gh, &wt, &branch, &task, previous.as_ref()).await?;
            (PrHost::Github, Some(url))
        }
        (PrHost::Gitlab, _) => gitlab(inner, &wt, &branch, &task, previous.as_ref()).await?,
        _ => {
            let out = push(&wt, &branch, &[]).await?;
            let url = link_from_push(&out)
                .map(|l| l.url)
                .or_else(|| previous.and_then(|p| p.url));
            (PrHost::Other, url)
        }
    };
    let record = PullRequest {
        url,
        host: Some(host),
        pushed_checkpoint,
    };
    let stored = record.clone();
    inner
        .update(id, move |t| {
            t.pull_request = Some(stored);
            Ok(())
        })
        .await?;
    Ok(record)
}

/// The host from the project setting, else detected from `origin`.
async fn pr_host(inner: &Inner, wt: &Path) -> Result<PrHost> {
    if let Some(host) = inner.settings().pull_request_host {
        return Ok(host);
    }
    let url = git::run_git(wt, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| {
            CoreError::Invalid(
                "the repository has no `origin` remote to push the task's branch to".into(),
            )
        })?;
    if let Some(host) = detect_host(&url) {
        return Ok(host);
    }
    // GitHub Enterprise: a host the GitHub CLI is logged in to.
    if let (Some(name), Ok(gh)) = (remote_host(&url), inner.bins.locate_tool("gh"))
        && gh_knows_host(inner, &gh, &name).await
    {
        return Ok(PrHost::Github);
    }
    Ok(PrHost::Other)
}

async fn gh_knows_host(inner: &Inner, gh: &Path, host: &str) -> bool {
    let mut cmd = crate::proc::command(gh);
    cmd.args(["auth", "status", "--hostname", host])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(p) = inner.bins.path_var() {
        cmd.env("PATH", p);
    }
    matches!(
        tokio::time::timeout(GH_HOST_CHECK, cmd.output()).await,
        Ok(Ok(out)) if out.status.success()
    )
}

/// The host part of a remote URL: `https://[user@]host[:port]/path`, `ssh://[user@]host[:port]/
/// path` or scp-like `[user@]host:path`. None for a local path or `file://`.
pub fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        rest.split('/').next()?
    } else {
        // scp-like: a colon before any slash. A Windows path (`C:\repo`, `C:/repo`) has a
        // one-letter "host", which no remote has.
        let (host, _) = url.split_once(':')?;
        if host.contains('/') || host.len() <= 1 {
            return None;
        }
        host
    };
    let host = authority.rsplit('@').next()?;
    // Drop a port; an IPv6 address is in brackets.
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next()?
    } else {
        host.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The host a remote URL names, when its name says it: github.com, gitlab.com, or a host with
/// "gitlab" in its name. None otherwise (a self-hosted GitHub Enterprise or GitLab under another
/// name, any other host, a local path).
pub fn detect_host(url: &str) -> Option<PrHost> {
    let host = remote_host(url)?;
    if host == "github.com" || host.ends_with(".github.com") {
        Some(PrHost::Github)
    } else if host.split(['.', '-']).any(|part| part == "gitlab") || host.contains("gitlab") {
        Some(PrHost::Gitlab)
    } else {
        None
    }
}

/// A link found in a push's remote messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushLink {
    pub url: String,
    /// An existing pull or merge request, not a page for opening one.
    pub opened: bool,
}

/// The pull request link in a push's output: an existing pull or merge request first, else the
/// first link the remote printed (a page for opening one). Only `remote:` lines count, so a URL
/// in a hook's own output is not taken for the host's.
pub fn link_from_push(output: &str) -> Option<PushLink> {
    let links: Vec<String> = output
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("remote:"))
        .flat_map(|rest| {
            rest.split_whitespace()
                .filter(|w| w.starts_with("https://") || w.starts_with("http://"))
                .map(|w| {
                    w.trim_end_matches(['.', ',', ')', '>', '"', '\''])
                        .to_string()
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let opened = |url: &str| {
        let path = url.split(['?', '#']).next().unwrap_or(url);
        let mut parts = path.rsplit('/');
        let last = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        !last.is_empty()
            && last.bytes().all(|b| b.is_ascii_digit())
            && matches!(kind, "merge_requests" | "pull" | "pulls" | "pull-requests")
    };
    if let Some(url) = links.iter().find(|u| opened(u)) {
        return Some(PushLink {
            url: url.clone(),
            opened: true,
        });
    }
    links
        .into_iter()
        .next()
        .map(|url| PushLink { url, opened: false })
}

/// Push the task's branch, with `-o` push options, and return the push's output.
async fn push(wt: &Path, branch: &str, options: &[String]) -> Result<String> {
    let refspec = format!("HEAD:refs/heads/{branch}");
    let mut args = vec!["push", "--force-with-lease", "-u"];
    for option in options {
        args.push("-o");
        args.push(option);
    }
    args.extend(["origin", refspec.as_str()]);
    git::run_git_all(wt, &args, NETWORK).await.map_err(|e| {
        if !options.is_empty() && e.to_string().contains("does not support push options") {
            CoreError::Invalid(
                "the remote does not accept push options, so it is not a GitLab that can open \
                 the merge request; set Pull requests to Other in Settings to push the branch \
                 only"
                    .into(),
            )
        } else {
            e
        }
    })
}

async fn github(
    inner: &Inner,
    gh: &Path,
    wt: &Path,
    branch: &str,
    task: &Task,
    previous: Option<&PullRequest>,
) -> Result<String> {
    if let Some(url) = previous.and_then(|p| p.url.clone()) {
        // Already open: the push updated the code; bring the description up to date too.
        if let Err(e) = gh_output(inner, gh, wt, &["pr", "edit", &url, "--body", &body(task)]).await
        {
            inner.emit(super::EngineEvent::Error {
                task_id: task.id.clone(),
                message: format!(
                    "the pull request's code was updated but its description was not: {e}"
                ),
            });
        }
        return Ok(url);
    }
    match existing_pr(inner, gh, wt, branch).await {
        Some(url) => Ok(url),
        None => match open_pr(inner, gh, wt, branch, task).await {
            Ok(url) => Ok(url),
            // It may have been created even though the call failed (a timeout, no URL printed).
            Err(e) => existing_pr(inner, gh, wt, branch).await.ok_or(e),
        },
    }
}

/// Open the merge request with push options on the first push; later pushes update it. If GitLab
/// printed no merge request (an older GitLab that ignores the options), the branch is still
/// pushed and the task keeps the page GitLab printed for opening one, as for any other host.
async fn gitlab(
    inner: &Inner,
    wt: &Path,
    branch: &str,
    task: &Task,
    previous: Option<&PullRequest>,
) -> Result<(PrHost, Option<String>)> {
    let opened_before = previous.filter(|p| p.host == Some(PrHost::Gitlab) && p.url.is_some());
    let options = if opened_before.is_some() {
        Vec::new()
    } else {
        let main = inner.worktrees.main_branch().await;
        vec![
            "merge_request.create".to_string(),
            format!("merge_request.target={main}"),
            format!("merge_request.title={}", one_line(&task.title, 250)),
            format!(
                "merge_request.description={}",
                one_line(&gitlab_description(task), 2000)
            ),
        ]
    };
    let out = push(wt, branch, &options).await?;
    match link_from_push(&out) {
        Some(link) if link.opened => Ok((PrHost::Gitlab, Some(link.url))),
        _ if opened_before.is_some() => {
            Ok((PrHost::Gitlab, opened_before.and_then(|p| p.url.clone())))
        }
        link => Ok((PrHost::Other, link.map(|l| l.url))),
    }
}

/// Push options cannot hold a newline: whitespace runs become one space, cut to `max` characters.
fn one_line(text: &str, max: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match joined.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &joined[..cut]),
        None => joined,
    }
}

/// The merge request description on one line (see `one_line`).
fn gitlab_description(task: &Task) -> String {
    let mut parts = Vec::new();
    if !task.description.trim().is_empty() {
        parts.push(task.description.trim().to_string());
    }
    let done: Vec<&str> = task
        .subtasks_of(SubtaskKind::Dev)
        .filter(|s| s.status == SubtaskStatus::Done)
        .map(|s| s.title.as_str())
        .collect();
    if !done.is_empty() {
        parts.push(format!("Done: {}.", done.join("; ")));
    }
    if let Some(feedback) = &task.review.feedback {
        parts.push(format!("Unresolved review findings: {feedback}"));
    }
    parts.push("Opened by Code-Automata.".into());
    parts.join(" ")
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

async fn gh_output(inner: &Inner, gh: &Path, wt: &Path, args: &[&str]) -> Result<String> {
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
async fn existing_pr(inner: &Inner, gh: &Path, wt: &Path, branch: &str) -> Option<String> {
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

async fn open_pr(inner: &Inner, gh: &Path, wt: &Path, branch: &str, task: &Task) -> Result<String> {
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn remote_hosts_are_read_from_every_url_form() {
        for (url, host) in [
            ("https://github.com/o/r.git", Some("github.com")),
            (
                "https://user:tok@GitLab.Example.com/g/r.git",
                Some("gitlab.example.com"),
            ),
            ("http://code.corp:8080/x.git", Some("code.corp")),
            ("ssh://git@gitlab.corp:2222/g/r.git", Some("gitlab.corp")),
            ("git@github.com:o/r.git", Some("github.com")),
            ("gitlab.internal:group/repo.git", Some("gitlab.internal")),
            ("ssh://git@[::1]:22/r.git", Some("::1")),
            ("/srv/git/repo.git", None),
            ("../remote.git", None),
            ("file:///srv/git/repo.git", None),
            ("C:\\repos\\remote.git", None),
            ("C:/repos/remote.git", None),
        ] {
            assert_eq!(remote_host(url).as_deref(), host, "{url}");
        }
    }

    #[test]
    fn hosts_are_detected_only_when_the_name_says_so() {
        for (url, host) in [
            ("git@github.com:o/r.git", Some(PrHost::Github)),
            ("https://github.com/o/r", Some(PrHost::Github)),
            ("https://gitlab.com/g/r.git", Some(PrHost::Gitlab)),
            ("git@gitlab.example.com:g/r.git", Some(PrHost::Gitlab)),
            ("https://git.example.com/gitlab/r.git", None),
            ("https://code.corp/x.git", None),
            ("https://bitbucket.org/o/r.git", None),
            ("/srv/git/repo.git", None),
        ] {
            assert_eq!(detect_host(url), host, "{url}");
        }
    }

    #[test]
    fn push_output_links_prefer_an_opened_request() {
        // GitLab, new branch with a merge request opened by push options.
        let gitlab_opened = "remote: \nremote: View merge request for code-automata/t1:\n\
            remote:   https://gitlab.corp/g/r/-/merge_requests/12\nremote: \n\
            To gitlab.corp:g/r.git\n * [new branch]      HEAD -> code-automata/t1\n";
        assert_eq!(
            link_from_push(gitlab_opened),
            Some(PushLink {
                url: "https://gitlab.corp/g/r/-/merge_requests/12".into(),
                opened: true
            })
        );
        // GitLab (older, no `/-/`), new branch without a merge request.
        let gitlab_new = "remote: To create a merge request for code-automata/t1, visit:\n\
            remote:   https://gitlab.corp/g/r/merge_requests/new?merge_request%5Bsource_branch%5D=code-automata%2Ft1\n";
        let link = link_from_push(gitlab_new).unwrap();
        assert!(!link.opened);
        assert!(link.url.contains("merge_requests/new?"), "{}", link.url);
        // GitHub.
        let github = "remote: Create a pull request for 'code-automata/t1' on GitHub by visiting:\n\
            remote:      https://github.com/o/r/pull/new/code-automata/t1\n";
        assert_eq!(
            link_from_push(github).unwrap().url,
            "https://github.com/o/r/pull/new/code-automata/t1"
        );
        // Gitea: an existing pull request.
        let gitea = "remote: Visit the existing pull request:\n\
            remote:   https://gitea.corp/o/r/pulls/3\n";
        assert!(link_from_push(gitea).unwrap().opened);
        // Bitbucket: a page for opening one.
        let bitbucket = "remote: Create pull request for code-automata/t1:\n\
            remote:   https://bitbucket.org/o/r/pull-requests/new?source=code-automata/t1&t=1\n";
        let link = link_from_push(bitbucket).unwrap();
        assert!(!link.opened && link.url.starts_with("https://bitbucket.org/"));
        // A URL in a hook's own output is not the host's.
        assert_eq!(
            link_from_push("see https://example.com/docs\nEverything up-to-date\n"),
            None
        );
    }

    #[test]
    fn push_options_are_one_line() {
        assert_eq!(
            one_line("Add\npaging\n\n  to  lists", 100),
            "Add paging to lists"
        );
        assert_eq!(one_line("abcdef", 3), "abc…");
        assert_eq!(one_line("ééé", 2), "éé…");
    }
}
