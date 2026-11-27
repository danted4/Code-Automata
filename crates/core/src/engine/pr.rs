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
//! A replan keeps the PR: the new run commits fresh checkpoints on the same branch, and the next
//! update squashes everything since the base commit and force-pushes it over the old commit.
//!
//! A workspace task does this for each repository it changed, one after another: a repository
//! that fails does not stop the rest, each success is recorded as it happens, and a retry skips
//! nothing but opens nothing twice (an open PR is found again and updated). A repository with no
//! `origin` remote is reported, not failed: its work stays on the task branch. Once the PRs exist,
//! each description lists the others where the host allows it (GitHub: always kept complete;
//! GitLab: as known at its push).

use std::path::Path;
use std::time::Duration;

use super::Inner;
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{Phase, PrHost, PullRequest, SubtaskKind, SubtaskStatus, Task};
use crate::util::ROOT_REPO;

const NETWORK: Duration = Duration::from_secs(90);
/// Local checks while detecting the host (`gh auth token`, `ssh -G`): config files only.
const LOCAL_CHECK: Duration = Duration::from_secs(10);

/// What opening or updating one repository's pull request did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrOutcome {
    /// The record now on the task.
    pub pull_request: PullRequest,
    /// Something the user should know although it worked (the branch was only pushed, say).
    pub note: Option<String>,
}

/// What happened in one repository.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrResult {
    /// Opened, updated or already up to date.
    Pushed {
        pull_request: PullRequest,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// No `origin` remote: the work is on the task branch in this repository.
    NoRemote {
        branch: String,
    },
    /// The task did not change this repository (or its changes add up to none).
    NoChanges,
    Failed {
        error: String,
    },
}

/// One row of a [`PrReport`].
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRow {
    pub repo: String,
    pub result: PrResult,
}

/// What "Create pull requests" did, one row per repository of the task, in name order.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct PrReport {
    pub rows: Vec<PrRow>,
}

pub(crate) async fn create(inner: &Inner, id: &str) -> Result<PrReport> {
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
    if !task.has_worktrees() {
        return Err(CoreError::Invalid("the task has no worktree".into()));
    }
    let named: Vec<String> = task.repos().map(String::from).collect();
    if !git::task_status(&inner.project, id, &named).await?.exists {
        return Err(CoreError::Invalid(
            "the task's worktree was removed; reopen the task to bring it back".into(),
        ));
    }

    // A one-repository task keeps 3.0's behaviour: a failure is the call's error. No remote is
    // a row, not an error, here; the single-result route (the pre-3.1 UI) refuses it.
    if task.base_commits.contains_key(ROOT_REPO) {
        let result = match create_one(inner, &task, ROOT_REPO, &[]).await? {
            Some(outcome) => {
                record(inner, id, ROOT_REPO, &outcome.pull_request).await?;
                PrResult::Pushed {
                    pull_request: outcome.pull_request,
                    note: outcome.note,
                }
            }
            None => PrResult::NoRemote {
                branch: Worktrees::branch_for(id),
            },
        };
        return Ok(PrReport {
            rows: vec![PrRow {
                repo: ROOT_REPO.to_string(),
                result,
            }],
        });
    }

    let changed = task.changed_repos();
    // Links known so far, for the "part of a change across" list in each description.
    let mut known: Vec<(String, String)> = task
        .pull_requests
        .iter()
        .filter_map(|(r, p)| Some((r.clone(), p.url.clone()?)))
        .collect();
    let mut rows = Vec::new();
    for repo in task.repos() {
        let result = if !changed.contains(&repo) {
            PrResult::NoChanges
        } else {
            let others: Vec<(String, String)> =
                known.iter().filter(|(r, _)| r != repo).cloned().collect();
            match create_one(inner, &task, repo, &others).await {
                Ok(Some(outcome)) => {
                    // Recorded at once: a later repository's failure must not lose it.
                    record(inner, id, repo, &outcome.pull_request).await?;
                    if let Some(url) = &outcome.pull_request.url {
                        known.retain(|(r, _)| r != repo);
                        known.push((repo.to_string(), url.clone()));
                    }
                    PrResult::Pushed {
                        pull_request: outcome.pull_request,
                        note: outcome.note,
                    }
                }
                Ok(None) => PrResult::NoRemote {
                    branch: Worktrees::branch_for(id),
                },
                Err(CoreError::Invalid(msg)) if msg.starts_with(NO_NET_CHANGE) => {
                    PrResult::NoChanges
                }
                Err(e) => PrResult::Failed {
                    error: e.to_string(),
                },
            }
        };
        rows.push(PrRow {
            repo: repo.to_string(),
            result,
        });
    }
    cross_link(inner, &task, &rows, &known).await;
    Ok(PrReport { rows })
}

async fn record(inner: &Inner, id: &str, repo: &str, pr: &PullRequest) -> Result<()> {
    let (repo, pr) = (repo.to_string(), pr.clone());
    inner
        .update(id, move |t| {
            t.pull_requests.insert(repo, pr);
            Ok(())
        })
        .await
        .map(drop)
}

const NO_NET_CHANGE: &str = "nothing to open a pull request for";

/// Squash, push and open or update `repo`'s pull request. `None` when the repository has no
/// `origin` remote. `related` lists the task's other PRs (repository, link) for the description.
async fn create_one(
    inner: &Inner,
    task: &Task,
    repo: &str,
    related: &[(String, String)],
) -> Result<Option<PrOutcome>> {
    let id = task.id.as_str();
    let worktrees = inner.repo_worktrees(repo)?;
    let wt = worktrees.path_for(id)?;
    let base = task
        .base_commit(repo)
        .ok_or_else(|| CoreError::Invalid("the task has no worktree".into()))?
        .to_string();
    if !git::status_at(&wt).await.exists {
        return Err(CoreError::Invalid(
            "the task's worktree was removed; reopen the task to bring it back".into(),
        ));
    }
    if git::run_git(&wt, &["remote", "get-url", "origin"])
        .await
        .is_err()
    {
        return Ok(None);
    }
    let branch = Worktrees::branch_for(id);

    // Everything that can fail without changing anything comes first: the host, and gh for it.
    let (host, mut note) = pr_host(inner, repo, &wt).await?;
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
        return Err(CoreError::Invalid(format!(
            "{NO_NET_CHANGE}: the task's changes add up to no change"
        )));
    }

    // The newest work the pushed commit holds, for the UI's "up to date".
    let pushed_checkpoint = task.newest_dev_checkpoint(repo).map(str::to_string);
    let previous = task.pull_requests.get(repo).cloned();
    let main = worktrees.main_branch().await;
    let pr = PrTarget {
        wt: &wt,
        branch: &branch,
        main: &main,
        related,
    };

    let (host, url) = match (host, gh) {
        (PrHost::Github, Some(gh)) => {
            push(&wt, &branch, &[]).await?;
            let url = github(inner, &gh, &pr, task, previous.as_ref()).await?;
            (PrHost::Github, Some(url))
        }
        (PrHost::Gitlab, _) => {
            let (host, url, gitlab_note) = gitlab(&pr, task, previous.as_ref()).await?;
            note = gitlab_note.or(note);
            (host, url)
        }
        _ => {
            let out = push(&wt, &branch, &[]).await?;
            (
                PrHost::Other,
                better_link(link_from_push(&out), previous.as_ref()),
            )
        }
    };
    Ok(Some(PrOutcome {
        pull_request: PullRequest {
            url,
            host: Some(host),
            pushed_checkpoint,
        },
        note,
    }))
}

/// Where one repository's pull request goes.
struct PrTarget<'a> {
    wt: &'a Path,
    branch: &'a str,
    /// The branch it targets.
    main: &'a str,
    /// The task's other PRs, for the description.
    related: &'a [(String, String)],
}

/// Bring every GitHub PR's "part of a change across" list up to date once all repositories are
/// done, since a PR opened early could not list the ones opened after it. Best effort: a failure
/// is reported as an engine error, never fails the call.
async fn cross_link(inner: &Inner, task: &Task, rows: &[PrRow], known: &[(String, String)]) {
    if known.len() < 2 {
        return;
    }
    let Ok(gh) = inner.bins.locate_tool("gh") else {
        return;
    };
    for row in rows {
        let PrResult::Pushed { pull_request, .. } = &row.result else {
            continue;
        };
        let (Some(PrHost::Github), Some(url)) = (pull_request.host, &pull_request.url) else {
            continue;
        };
        let Ok(wt) = inner
            .repo_worktrees(&row.repo)
            .and_then(|w| w.path_for(&task.id))
        else {
            continue;
        };
        let others: Vec<(String, String)> = known
            .iter()
            .filter(|(r, _)| *r != row.repo)
            .cloned()
            .collect();
        let body = body(task, &others);
        if let Err(e) = gh_output(inner, &gh, &wt, &["pr", "edit", url, "--body", &body]).await {
            inner.emit(super::EngineEvent::Error {
                task_id: task.id.clone(),
                message: format!(
                    "{}: the PR description could not list the others: {e}",
                    row.repo
                ),
            });
        }
    }
}

/// The link to keep: an existing request the push reported, else the link already kept, else a
/// page for opening one. A weaker link never replaces a stronger one.
fn better_link(found: Option<PushLink>, previous: Option<&PullRequest>) -> Option<String> {
    match found {
        Some(link) if link.opened => Some(link.url),
        found => previous
            .and_then(|p| p.url.clone())
            .or(found.map(|l| l.url)),
    }
}

/// The host from the project setting, else detected from `origin`, with a note for the user
/// when a remote host fell back to push only.
async fn pr_host(inner: &Inner, repo: &str, wt: &Path) -> Result<(PrHost, Option<String>)> {
    if let Some(host) = inner.settings().pull_request_host_for(repo) {
        return Ok((host, None));
    }
    let url = git::run_git(wt, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| {
            CoreError::Invalid(
                "the repository has no `origin` remote to push the task's branch to".into(),
            )
        })?;
    let Some(raw) = remote_host_as_written(&url) else {
        // A local folder: nothing to open a pull request on.
        return Ok((PrHost::Other, None));
    };
    let mut name = raw.to_ascii_lowercase();
    // An SSH host alias (`git@github-work:org/repo.git`, for a second account) stands for the
    // host named in ~/.ssh/config. `Host` patterns are case-sensitive, so the alias goes to ssh
    // as written.
    if is_ssh_url(&url)
        && let Some(real) = ssh_hostname(inner, &raw).await
    {
        name = real;
    }
    if let Some(host) = detect_host_name(&name) {
        return Ok((host, None));
    }
    // GitHub Enterprise: a host the GitHub CLI has a login for.
    if let Ok(gh) = inner.bins.locate_tool("gh")
        && gh_has_login(inner, &gh, &name).await
    {
        return Ok((PrHost::Github, None));
    }
    Ok((
        PrHost::Other,
        Some(format!(
            "{name} is not github.com or a GitLab address and the GitHub CLI has no login for it, \
             so the branch was only pushed. If it is GitHub Enterprise or GitLab, choose it under \
             Settings → Pull requests."
        )),
    ))
}

/// Whether the GitHub CLI has a login for `host`, from its config alone: `gh auth token` reads
/// the stored token without asking the host (`gh auth status` would). The token is never read.
async fn gh_has_login(inner: &Inner, gh: &Path, host: &str) -> bool {
    let mut cmd = crate::proc::command(gh);
    cmd.args(["auth", "token", "--hostname", host])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(p) = inner.bins.path_var() {
        cmd.env("PATH", p);
    }
    matches!(
        tokio::time::timeout(LOCAL_CHECK, cmd.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

/// The real host behind an SSH host alias, from `ssh -G` (which only reads the SSH config).
async fn ssh_hostname(inner: &Inner, alias: &str) -> Option<String> {
    if !safe_ssh_alias(alias) {
        return None;
    }
    let mut cmd = crate::proc::command("ssh");
    cmd.args(["-G", alias])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(p) = inner.bins.path_var() {
        cmd.env("PATH", p);
    }
    let out = tokio::time::timeout(LOCAL_CHECK, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    hostname_from_ssh_config(&String::from_utf8_lossy(&out.stdout))
}

/// Never let a remote URL pass an option to ssh (git refuses such hosts too).
pub fn safe_ssh_alias(alias: &str) -> bool {
    !alias.is_empty() && !alias.starts_with('-')
}

/// The `hostname` line of `ssh -G` output.
pub fn hostname_from_ssh_config(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("hostname "))
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
}

/// An `ssh://` or scp-like (`user@host:path`) remote, where the host can be an SSH alias.
pub fn is_ssh_url(url: &str) -> bool {
    let url = url.trim();
    match url.split_once("://") {
        Some((scheme, _)) => {
            scheme.eq_ignore_ascii_case("ssh") || scheme.eq_ignore_ascii_case("git+ssh")
        }
        None => remote_host(url).is_some(),
    }
}

/// The host part of a remote URL, lowercased (see `remote_host_as_written`).
pub fn remote_host(url: &str) -> Option<String> {
    remote_host_as_written(url).map(|h| h.to_ascii_lowercase())
}

/// The host part of a remote URL as written: `https://[user@]host[:port]/path`,
/// `ssh://[user@]host[:port]/path` or scp-like `[user@]host:path`. None for a local path or
/// `file://`.
pub fn remote_host_as_written(url: &str) -> Option<String> {
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
    (!host.is_empty()).then(|| host.to_string())
}

/// The host a remote URL names, when its name says it (see `detect_host_name`).
pub fn detect_host(url: &str) -> Option<PrHost> {
    detect_host_name(&remote_host(url)?)
}

/// github.com, or gitlab.com and hosts with a name part that starts with "gitlab"
/// (`gitlab.corp`, `gitlab2.example.com`). None otherwise: a self-hosted GitHub Enterprise or
/// GitLab under another name, any other host.
pub fn detect_host_name(host: &str) -> Option<PrHost> {
    let host = host.to_ascii_lowercase();
    if host == "github.com" || host.ends_with(".github.com") {
        Some(PrHost::Github)
    } else if host.split('.').any(|part| part.starts_with("gitlab")) {
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

/// The pull request link in a push's output: an existing pull or merge request first, else a page
/// for opening one (`pull/new`, `merge_requests/new`, `pull-requests/new`, `compare`). Other links
/// (a policy page, a security notice) are ignored. Only `remote:` lines count, so a URL in a
/// hook's own output is not taken for the host's.
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
    let create_page = |url: &str| {
        let path = url.split(['?', '#']).next().unwrap_or(url);
        [
            "/pull/new/",
            "/merge_requests/new",
            "/pull-requests/new",
            "/compare/",
            "/pulls/new",
        ]
        .iter()
        .any(|p| path.contains(p))
    };
    links
        .into_iter()
        .find(|u| create_page(u))
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
    pr: &PrTarget<'_>,
    task: &Task,
    previous: Option<&PullRequest>,
) -> Result<String> {
    let (wt, branch) = (pr.wt, pr.branch);
    // Only a link recorded for GitHub is a GitHub PR (records from before 3.0.1 have no host).
    let open = previous
        .filter(|p| matches!(p.host, None | Some(PrHost::Github)))
        .and_then(|p| p.url.clone());
    if let Some(url) = open {
        // Already open: the push updated the code; bring the description up to date too.
        let body = body(task, pr.related);
        if let Err(e) = gh_output(inner, gh, wt, &["pr", "edit", &url, "--body", &body]).await {
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
        None => match open_pr(inner, gh, pr, task).await {
            Ok(url) => Ok(url),
            // It may have been created even though the call failed (a timeout, no URL printed).
            Err(e) => existing_pr(inner, gh, wt, branch).await.ok_or(e),
        },
    }
}

/// Push with the merge request options every time. GitLab opens the merge request for the branch
/// if none is open (the first push, or after the last one was closed or merged) and updates the
/// open one's title and description otherwise, then prints its link. (GitLab's handling of an
/// open merge request is from its docs and memory; no real GitLab was tried, see the 3.0.1
/// notes.)
///
/// - A merge request link: recorded as GitLab.
/// - No link, but one recorded before: the push sent nothing new (the branch already had the
///   squash), so the merge request is unchanged.
/// - Only a page for opening one (an older GitLab that ignores the options): the branch is pushed,
///   recorded as "other" with that page, and the user is told.
/// - No link at all: an error, and nothing is recorded, so the UI does not call it up to date.
async fn gitlab(
    pr: &PrTarget<'_>,
    task: &Task,
    previous: Option<&PullRequest>,
) -> Result<(PrHost, Option<String>, Option<String>)> {
    let (wt, branch) = (pr.wt, pr.branch);
    let options = vec![
        "merge_request.create".to_string(),
        format!("merge_request.target={}", pr.main),
        format!("merge_request.title={}", one_line(&task.title, 250)),
        format!(
            "merge_request.description={}",
            one_line(&gitlab_description(task, pr.related), 2000)
        ),
    ];
    let out = push(wt, branch, &options).await?;
    let recorded = previous
        .filter(|p| p.host == Some(PrHost::Gitlab))
        .and_then(|p| p.url.clone());
    match (link_from_push(&out), recorded) {
        (Some(link), _) if link.opened => Ok((PrHost::Gitlab, Some(link.url), None)),
        (None, Some(url)) => Ok((PrHost::Gitlab, Some(url), None)),
        (Some(page), _) => Ok((
            PrHost::Other,
            Some(page.url),
            Some(
                "the branch is pushed, but GitLab did not open the merge request (an older \
                 GitLab may ignore push options); open it with the link"
                    .into(),
            ),
        )),
        (None, None) => Err(CoreError::Invalid(format!(
            "{branch} is pushed, but GitLab printed no merge request. If the branch was already \
             up to date there, nothing was sent for GitLab to act on. Open the merge request on \
             GitLab, or set Pull requests to Other in Settings."
        ))),
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
fn gitlab_description(task: &Task, related: &[(String, String)]) -> String {
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
    if !related.is_empty() {
        let list: Vec<String> = related.iter().map(|(r, u)| format!("{r}: {u}")).collect();
        parts.push(format!("Part of a change across: {}.", list.join("; ")));
    }
    parts.push("Opened by Code-Automata.".into());
    parts.join(" ")
}

fn body(task: &Task, related: &[(String, String)]) -> String {
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
    if !related.is_empty() {
        body.push_str("\n## Part of a change across\n\n");
        for (repo, url) in related {
            body.push_str(&format!("- {repo}: {url}\n"));
        }
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

async fn open_pr(inner: &Inner, gh: &Path, pr: &PrTarget<'_>, task: &Task) -> Result<String> {
    let (wt, branch, main) = (pr.wt, pr.branch, pr.main);
    let body = body(task, pr.related);
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
            main,
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
            ("https://gitlab2.example.com/g/r.git", Some(PrHost::Gitlab)),
            ("https://notgitlab-mirror.corp/g/r.git", None),
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
        // Gitea: a page for opening one.
        let gitea_new = "remote: Create a new pull request for 'code-automata/t1':\n\
            remote:   https://gitea.corp/o/r/compare/main...code-automata/t1\n";
        assert!(!link_from_push(gitea_new).unwrap().opened);
        // A policy page or a security notice is not a pull request link.
        let notice = "remote: GitHub found 2 vulnerabilities on o/r's default branch:\n\
            remote:      https://github.com/o/r/security/dependabot\n\
            remote: Push policy: https://wiki.corp/push-rules\n";
        assert_eq!(link_from_push(notice), None);
        // A URL in a hook's own output is not the host's.
        assert_eq!(
            link_from_push("see https://example.com/docs\nEverything up-to-date\n"),
            None
        );
    }

    #[test]
    fn a_weaker_link_never_replaces_a_kept_one() {
        let kept = PullRequest {
            url: Some("https://gitea.corp/o/r/pulls/3".into()),
            host: Some(PrHost::Other),
            pushed_checkpoint: None,
        };
        let page = |opened| PushLink {
            url: if opened {
                "https://gitea.corp/o/r/pulls/4".into()
            } else {
                "https://gitea.corp/o/r/compare/main...b".into()
            },
            opened,
        };
        assert_eq!(
            better_link(Some(page(false)), Some(&kept)).as_deref(),
            Some("https://gitea.corp/o/r/pulls/3")
        );
        assert_eq!(
            better_link(Some(page(true)), Some(&kept)).as_deref(),
            Some("https://gitea.corp/o/r/pulls/4")
        );
        assert_eq!(
            better_link(None, Some(&kept)).as_deref(),
            Some("https://gitea.corp/o/r/pulls/3")
        );
        assert_eq!(
            better_link(Some(page(false)), None).as_deref(),
            Some("https://gitea.corp/o/r/compare/main...b")
        );
        assert_eq!(better_link(None, None), None);
    }

    #[test]
    fn ssh_aliases_are_recognised_and_resolved_from_ssh_g_output() {
        assert!(is_ssh_url("git@github-work:org/repo.git"));
        assert!(is_ssh_url("ssh://git@github-work/org/repo.git"));
        assert!(!is_ssh_url("https://github.com/o/r.git"));
        assert!(!is_ssh_url("/srv/git/repo.git"));
        let out = "user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/work\n";
        assert_eq!(hostname_from_ssh_config(out).as_deref(), Some("github.com"));
        assert_eq!(
            detect_host_name(&hostname_from_ssh_config(out).unwrap()),
            Some(PrHost::Github)
        );
        assert_eq!(hostname_from_ssh_config("user git\nport 22\n"), None);
        assert!(safe_ssh_alias("github-work"));
        assert!(!safe_ssh_alias("-oProxyCommand=x"));
        assert!(!safe_ssh_alias(""));
        // ssh `Host` patterns are case-sensitive: the alias keeps its case for ssh.
        assert_eq!(
            remote_host_as_written("git@GitHub-Work:org/repo.git").as_deref(),
            Some("GitHub-Work")
        );
        assert_eq!(
            remote_host("git@GitHub-Work:org/repo.git").as_deref(),
            Some("github-work")
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
