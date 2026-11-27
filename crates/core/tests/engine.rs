//! The run engine end to end, with the scripted mock agent playing every step.
//!
//! These are the Phase 3 acceptance tests: crash and resume, pause, context, checkpoints and the
//! pull request, failure, timeout, planning with approval, check and QA rework, one window per
//! project, skip, and a worktree moved by hand.
#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use ca_core::engine::settings::{CheckCommand, Settings};
use ca_core::task::{Answer, Task};
use ca_core::util::ROOT_REPO;
use ca_core::{
    AgentConfig, CoreError, Phase, PlanningStage, ProjectDir, Provider, RunKind, RunState,
    SubtaskStatus, TaskStore,
};
use common::{TempRepo, alive, git};
use serde_json::{Value, json};
use tempfile::TempDir;

const PLAN: &str = "# Pagination\n\n## Overview\nPage the list.\n\n## Implementation Steps\n1. cursor\n2. next field\n\nPLAN-MARKER";

struct Env {
    repo: TempRepo,
    project: ProjectDir,
    files: TempDir,
}

impl Env {
    async fn new() -> Env {
        let repo = TempRepo::new();
        let project = repo.project().await;
        let env = Env {
            repo,
            project,
            files: tempfile::tempdir().unwrap(),
        };
        env.settings(|_| {}).await;
        env
    }

    /// Fast timeouts and no automatic checks unless a test sets them.
    async fn settings(&self, change: impl FnOnce(&mut Settings)) {
        let mut s = Settings {
            checks: Some(vec![]),
            ..Settings::default()
        };
        s.timeouts.idle_minutes = 0.5;
        s.timeouts.total_minutes = 2.0;
        change(&mut s);
        s.save(&self.project).await.unwrap();
    }

    fn path(&self, name: &str) -> PathBuf {
        self.files.path().join(name)
    }

    fn bins(&self) -> Binaries {
        Binaries::from_env().with_override(Provider::Mock, env!("CARGO_BIN_EXE_mock-agent"))
    }

    async fn engine(&self) -> Engine {
        Engine::open(self.project.clone(), self.bins())
            .await
            .unwrap()
    }

    /// A mock agent playing `extra` rules first, then the standard ones for `devs` dev subtasks.
    fn agent(&self, devs: usize, extra: Vec<Value>) -> AgentConfig {
        let mut rules = extra;
        rules.extend(standard_rules(devs, &self.path("once")));
        let scenario = self.path("scenario.json");
        std::fs::write(
            &scenario,
            json!({ "rules": rules, "steps": [
                { "result": { "isError": true, "text": "no rule matched this prompt" } }
            ]})
            .to_string(),
        )
        .unwrap();
        let mut agent = AgentConfig::new(Provider::Mock);
        agent
            .options
            .insert("scenario".into(), json!(scenario.to_str().unwrap()));
        agent.options.insert(
            "record".into(),
            json!(self.path("record.ndjson").to_str().unwrap()),
        );
        agent
    }

    fn once(&self, name: &str) -> String {
        self.path(&format!("once-{name}"))
            .to_string_lossy()
            .into_owned()
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("record.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn prompts_with(&self, needle: &str) -> Vec<Value> {
        self.records()
            .into_iter()
            .filter(|r| r["prompt"].as_str().unwrap().contains(needle))
            .collect()
    }

    fn worktree(&self, id: &str) -> PathBuf {
        self.project.worktrees_dir().join(id)
    }
}

fn structured(v: Value) -> Value {
    json!({ "result": { "text": "done", "structured": v } })
}

fn dev_answer(id: &str) -> Value {
    structured(json!({ "summary": format!("did {id}"), "handoff": format!("note from {id}") }))
}

fn standard_rules(devs: usize, _once_dir: &Path) -> Vec<Value> {
    let mut subtasks: Vec<Value> = (1..=devs)
        .map(|i| json!({ "id": format!("dev-{i}"), "kind": "dev", "title": format!("Step {i}"), "detail": format!("Do step {i}") }))
        .collect();
    subtasks
        .push(json!({ "id": "qa-1", "kind": "qa", "title": "Verify", "detail": "Check it works" }));
    let mut rules = vec![
        json!({ "whenPrompt": "You were interrupted before finishing", "steps": [
            { "write": { "path": "resumed.txt", "content": "resumed" } },
            dev_answer("resumed")
        ]}),
        json!({ "whenPrompt": "# Planning: clarifying questions", "steps": [
            structured(json!({ "questions": [
                { "id": "q1", "text": "Cursor or offset?", "options": ["cursor", "offset"], "required": true }
            ]}))
        ]}),
        json!({ "whenPrompt": "Revise the implementation plan", "steps": [
            structured(json!({ "plan": format!("{PLAN}\n\nREVISED") }))
        ]}),
        json!({ "whenPrompt": "# Planning: implementation plan", "steps": [
            structured(json!({ "plan": PLAN }))
        ]}),
        json!({ "whenPrompt": "Break the approved plan", "steps": [
            structured(json!({ "subtasks": subtasks }))
        ]}),
        json!({ "whenPrompt": "(rework-", "steps": [
            { "write": { "path": "fixed.txt", "content": "fixed" } },
            dev_answer("rework")
        ]}),
        json!({ "whenPrompt": "(qa-1)", "steps": [
            structured(json!({ "passed": true, "summary": "works", "findings": [] }))
        ]}),
    ];
    for i in 1..=devs {
        rules.push(json!({ "whenPrompt": format!("(dev-{i})"), "steps": [
            { "write": { "path": format!("dev-{i}.txt"), "content": format!("dev {i}") } },
            dev_answer(&format!("dev-{i}"))
        ]}));
    }
    rules
}

async fn wait_for(store: &TaskStore, id: &str, what: &str, pred: impl Fn(&Task) -> bool) -> Task {
    for _ in 0..600 {
        if let Ok(Some(t)) = store.load(id).await
            && pred(&t)
        {
            return t;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "timed out waiting for: {what}; task: {:?}",
        store.load(id).await
    );
}

async fn wait_dead(pid: u32) -> bool {
    for _ in 0..100 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn commits_since(wt: &Path, base: &str) -> usize {
    git(wt, &["rev-list", "--count", &format!("{base}..HEAD")])
        .parse()
        .unwrap()
}

async fn run_to_end(engine: &Engine, id: &str) -> Task {
    engine.start(id).await.unwrap();
    engine.wait_idle(id).await;
    engine.get_task(id).await.unwrap().unwrap()
}

fn hang_once(env: &Env, prompt: &str, before: Vec<Value>) -> Value {
    let mut steps = before;
    steps.push(json!({ "text": "working" }));
    steps.push(json!({ "hang": true }));
    json!({ "whenPrompt": prompt, "onceFile": env.once(prompt), "steps": steps })
}

// 1 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_mid_subtask_resumes_on_that_subtask_with_its_partial_work() {
    let env = Env::new().await;
    let agent = env.agent(
        3,
        vec![hang_once(
            &env,
            "(dev-2)",
            vec![json!({ "write": { "path": "dev-2-partial.txt", "content": "half" } })],
        )],
    );
    let store = TaskStore::new(&env.project);
    let task = store
        .create(Task::new("Crash me", "", agent))
        .await
        .unwrap();

    // The engine runs in another process, which is killed mid-subtask.
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_ca-engine"))
        .args([env.repo.path.to_str().unwrap(), "start", &task.id])
        .env("CODE_AUTOMATA_MOCK_AGENT", env!("CARGO_BIN_EXE_mock-agent"))
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let wt = env.worktree(&task.id);
    let running = wait_for(
        &store,
        &task.id,
        "dev-2 running with its partial file",
        |t| {
            t.run.as_ref().is_some_and(|r| {
                r.subtask_id.as_deref() == Some("dev-2")
                    && r.pid.is_some()
                    && (cfg!(windows) || r.process_started.is_some())
            }) && wt.join("dev-2-partial.txt").exists()
        },
    )
    .await;
    let agent_pid = running.run.unwrap().pid.unwrap();
    child.kill().unwrap(); // SIGKILL / TerminateProcess: no shutdown, no cleanup
    child.wait().unwrap();
    if cfg!(windows) {
        // The agent's Job Object closed with the engine, taking the agent with it.
        assert!(
            wait_dead(agent_pid).await,
            "the agent outlived its engine (job object not killed on close)"
        );
    } else {
        assert!(
            alive(agent_pid),
            "the agent should outlive its engine (own process group)"
        );
    }

    // Reopen: the orphan is stopped and the run is interrupted, on dev-2.
    let engine = env.engine().await;
    assert!(
        wait_dead(agent_pid).await,
        "reconcile did not stop the orphaned agent"
    );
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    let run = t.run.as_ref().unwrap();
    assert_eq!(run.state, RunState::Interrupted);
    assert_eq!(run.subtask_id.as_deref(), Some("dev-2"));
    assert_eq!(t.subtask("dev-1").unwrap().status, SubtaskStatus::Done);

    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    assert_eq!(env.prompts_with("(dev-1)").len(), 1, "dev-1 must not rerun");
    let resumed = env.prompts_with("You were interrupted");
    assert_eq!(resumed.len(), 1);
    assert_eq!(
        resumed[0]["resume"], true,
        "the same session must be continued"
    );
    assert!(
        resumed[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("dev-2-partial.txt"),
        "the resumed prompt must show the partial work"
    );
    assert_eq!(env.prompts_with("(dev-3)").len(), 1);
    let base = t.base_commit(ROOT_REPO).unwrap().to_string();
    assert_eq!(
        commits_since(&wt, &base),
        3,
        "one checkpoint per dev subtask"
    );
    assert!(wt.join("dev-2-partial.txt").exists(), "partial work kept");
}

// 2 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn pause_stops_now_and_resume_continues_the_same_subtask() {
    let env = Env::new().await;
    let agent = env.agent(2, vec![hang_once(&env, "(dev-1)", vec![])]);
    let engine = env.engine().await;
    let task = engine
        .create_task("Pause me", "", agent, false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    let running = wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "dev-1 running",
        |t| {
            t.run
                .as_ref()
                .is_some_and(|r| r.subtask_id.as_deref() == Some("dev-1") && r.pid.is_some())
        },
    )
    .await;
    let pid = running.run.unwrap().pid.unwrap();

    engine.pause(&task.id).await.unwrap();
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    let run = t.run.as_ref().unwrap();
    assert_eq!(run.state, RunState::Paused);
    assert_eq!(run.subtask_id.as_deref(), Some("dev-1"));
    assert_eq!(t.phase, Phase::InProgress, "the card stays where it is");
    assert!(wait_dead(pid).await, "the agent survived the pause");
    assert!(
        engine.start(&task.id).await.is_err(),
        "a paused task is resumed, not started"
    );

    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview);
    assert_eq!(env.prompts_with("You were interrupted")[0]["resume"], true);
}

// 3 + 4 --------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake gh is a shell script
async fn later_subtasks_get_the_plan_and_handoffs_and_checkpoints_squash_into_the_pr() {
    let env = Env::new().await;
    let agent = env.agent(3, vec![]);

    // A remote to push to, and a fake gh that prints a PR URL.
    let remote = env.path("remote.git");
    git(
        env.files.path(),
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(
        &env.repo.path,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let gh = env.path("gh");
    // Like the real gh: `pr view` finds nothing until `pr create` has made the PR.
    let made = env.path("pr-made");
    std::fs::write(
        &gh,
        format!(
            "#!/bin/sh\n\
             case \"$1 $2\" in\n\
             \"pr view\") if [ -f {made} ]; then echo https://github.com/example/repo/pull/7; else echo 'no pull requests found' >&2; exit 1; fi ;;\n\
             \"pr create\") echo \"$@\" > {args}; touch {made}; echo https://github.com/example/repo/pull/7 ;;\n\
             \"pr edit\") echo \"$@\" > {edited} ;;\n\
             *) exit 2 ;;\n\
             esac\n",
            made = made.display(),
            args = env.path("gh-args").display(),
            edited = env.path("gh-edited").display()
        ),
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", gh.to_str().unwrap()])
        .status()
        .unwrap();
    let engine = Engine::open(env.project.clone(), env.bins().with_tool("gh", &gh))
        .await
        .unwrap();
    use_github(&engine).await;

    let task = engine
        .create_task("Paging", "Add paging", agent, false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);

    let p3 = env.prompts_with("(dev-3)");
    let prompt = p3[0]["prompt"].as_str().unwrap();
    assert!(
        prompt.contains("PLAN-MARKER"),
        "plan missing from the dev prompt"
    );
    assert!(prompt.contains("note from dev-1") && prompt.contains("note from dev-2"));

    let wt = env.worktree(&task.id);
    let base = t.base_commit(ROOT_REPO).unwrap().to_string();
    assert_eq!(commits_since(&wt, &base), 3);
    assert!(
        t.subtasks
            .iter()
            .filter(|s| !s.checkpoints.is_empty())
            .count()
            == 3
    );

    // The repository's pre-push hook runs for the PR push.
    let hook_ran = env.path("pre-push-ran");
    let hook = env.repo.path.join(".git/hooks/pre-push");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", hook_ran.display())).unwrap();
    std::process::Command::new("chmod")
        .args(["+x", hook.to_str().unwrap()])
        .status()
        .unwrap();

    let url = pr_url(&engine, &task.id).await;
    assert_eq!(url, "https://github.com/example/repo/pull/7");
    assert!(hook_ran.exists(), "the pre-push hook did not run");
    assert_eq!(commits_since(&wt, &base), 1, "checkpoints squashed");
    let branch = format!("code-automata/{}", task.id);
    let pushed = git(
        &remote,
        &["rev-list", "--count", &format!("{base}..{branch}")],
    );
    assert_eq!(pushed, "1");
    let args = std::fs::read_to_string(env.path("gh-args")).unwrap();
    assert!(
        args.contains("pr create") && args.contains(&branch),
        "{args}"
    );
    assert_eq!(
        pr_url(&engine, &task.id).await,
        url,
        "asking again returns the same PR"
    );
    // The PR records the newest checkpoint it holds; the UI calls it current while that is still
    // the task's newest.
    let current = |t: &ca_core::Task| {
        let pushed = t.pull_requests[ROOT_REPO].clone().pushed_checkpoint;
        pushed.is_some() && pushed.as_deref() == t.newest_dev_checkpoint(ROOT_REPO)
    };
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert!(current(&t), "the PR holds the newest checkpoint");

    // Rework after the PR is open: asking again pushes the new work to the same PR.
    engine
        .request_rework(&task.id, "Rename the endpoint")
        .await
        .unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview);
    assert!(
        t.review.feedback.is_none(),
        "a passing review must clear old findings"
    );
    assert!(!current(&t), "not pushed yet: the PR lacks the rework");
    std::fs::remove_file(env.path("gh-args")).unwrap();
    assert_eq!(pr_url(&engine, &task.id).await, url);
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert!(current(&t), "updated: the PR holds the rework too");
    assert_eq!(
        git(&remote, &["rev-parse", &branch]),
        git(&wt, &["rev-parse", "HEAD"])
    );
    assert_eq!(commits_since(&wt, &base), 1);
    assert!(!env.path("gh-args").exists(), "no second `gh pr create`");
    let edited = std::fs::read_to_string(env.path("gh-edited")).unwrap();
    assert!(
        edited.contains("pr edit") && edited.contains("--body"),
        "{edited}"
    );

    // Replan with the PR open: the new run's work is not in the PR, whatever its size, until the
    // next update force-pushes it over the old commit.
    engine.move_task(&task.id, Phase::Planning).await.unwrap();
    engine.approve_plan(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview);
    assert!(
        t.pull_requests.contains_key(ROOT_REPO),
        "a replan keeps the PR"
    );
    assert!(!current(&t), "the replan's new work is not in the PR");
    assert_eq!(pr_url(&engine, &task.id).await, url);
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert!(current(&t), "updated after the replan");
    assert_eq!(
        git(&remote, &["rev-parse", &branch]),
        git(&wt, &["rev-parse", "HEAD"])
    );
    assert_eq!(commits_since(&wt, &base), 1);
}

/// Open (or update) the task's PR and return its link.
#[cfg(unix)]
async fn pr_url(engine: &Engine, id: &str) -> String {
    let pr = pushed(engine.create_pull_request(id).await.unwrap());
    pr.url.expect("the PR has a link")
}

/// The test remotes are local folders, which name no host: say it is GitHub, as a project
/// would for a GitHub Enterprise host whose name says nothing.
#[cfg(unix)]
async fn use_github(engine: &Engine) {
    engine
        .save_settings(Settings {
            pull_request_host: Some(ca_core::PrHost::Github),
            ..engine.settings()
        })
        .await
        .unwrap();
}

#[cfg(unix)]
fn fake_gh(env: &Env, create: &str) -> PathBuf {
    let gh = env.path("gh");
    let made = env.path("pr-made");
    std::fs::write(
        &gh,
        format!(
            "#!/bin/sh\ncase \"$1 $2\" in\n\
             \"pr view\") if [ -f {made} ]; then echo https://github.com/example/repo/pull/9; else exit 1; fi ;;\n\
             \"pr create\") touch {made}; {create} ;;\n\
             esac\n",
            made = made.display()
        ),
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", gh.to_str().unwrap()])
        .status()
        .unwrap();
    gh
}

#[cfg(unix)]
async fn reviewed_task_with_remote(env: &Env, dev_writes: bool) -> (Engine, String) {
    reviewed_task_on(env, dev_writes, Some(ca_core::PrHost::Github)).await
}

/// A reviewed task whose project pushes to a local bare remote, with `host` as the pull request
/// setting (None: detect, which a local folder makes "other").
#[cfg(unix)]
async fn reviewed_task_on(
    env: &Env,
    dev_writes: bool,
    host: Option<ca_core::PrHost>,
) -> (Engine, String) {
    let remote = env.path("remote.git");
    git(
        env.files.path(),
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(
        &env.repo.path,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let extra = if dev_writes {
        vec![]
    } else {
        vec![json!({ "whenPrompt": "(dev-1)", "steps": [dev_answer("dev-1")] })]
    };
    let agent = env.agent(1, extra);
    let gh = env.path("gh");
    let engine = Engine::open(env.project.clone(), env.bins().with_tool("gh", &gh))
        .await
        .unwrap();
    engine
        .save_settings(Settings {
            pull_request_host: host,
            ..engine.settings()
        })
        .await
        .unwrap();
    let task = engine.create_task("PR", "", agent, false).await.unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);
    (engine, task.id)
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake gh is a shell script
async fn a_task_that_changed_nothing_has_no_pull_request() {
    let env = Env::new().await;
    fake_gh(&env, "echo https://github.com/example/repo/pull/9");
    let (engine, id) = reviewed_task_with_remote(&env, false).await;
    let err = engine.create_pull_request(&id).await.unwrap_err();
    assert!(err.to_string().contains("nothing to open"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake gh is a shell script
async fn a_pr_that_gh_made_but_failed_to_report_is_still_found() {
    let env = Env::new().await;
    fake_gh(&env, "echo 'timeout talking to GitHub' >&2; exit 1");
    let (engine, id) = reviewed_task_with_remote(&env, true).await;
    let url = pr_url(&engine, &id).await;
    assert_eq!(url, "https://github.com/example/repo/pull/9");
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(
        t.pull_requests[ROOT_REPO].clone().url.as_deref(),
        Some(url.as_str())
    );
}

/// A remote hook that prints `lines` the way a host does (git shows them as `remote:` lines) and
/// records the push options it got, one per line, in `options-<n>` (n counts pushes).
#[cfg(unix)]
fn remote_says(env: &Env, lines: &str, push_options: bool) {
    let remote = env.path("remote.git");
    if push_options {
        git(&remote, &["config", "receive.advertisePushOptions", "true"]);
    }
    let hook = remote.join("hooks/pre-receive");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh
             cat > /dev/null
             n=$(ls {dir} | grep -c '^options-')
             out={dir}/options-$n
             : > $out
             i=0
             while [ $i -lt ${{GIT_PUSH_OPTION_COUNT:-0}} ]; do eval \"echo \\$GIT_PUSH_OPTION_$i\" >> $out; i=$((i+1)); done
             printf '%s\\n' \"{lines}\" >&2
",
            dir = env.files.path().display(),
        ),
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", hook.to_str().unwrap()])
        .status()
        .unwrap();
}

/// The push options of push `n`; empty when that push never reached the hook (a re-squash in
/// the same second makes the same commit, and git sends nothing).
#[cfg(unix)]
fn push_options(env: &Env, n: usize) -> String {
    std::fs::read_to_string(env.path(&format!("options-{n}"))).unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the remote hook is a shell script
async fn gitlab_merge_requests_are_opened_with_push_options_and_no_cli() {
    let env = Env::new().await;
    // gh would fail the test if it ran.
    fake_gh(&env, "echo should-not-run > /dev/null; exit 9");
    let (engine, id) = reviewed_task_on(&env, true, Some(ca_core::PrHost::Gitlab)).await;
    remote_says(
        &env,
        "View merge request for the branch:\n  https://gitlab.corp/g/r/-/merge_requests/12",
        true,
    );
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(pr.host, Some(ca_core::PrHost::Gitlab));
    assert_eq!(
        pr.url.as_deref(),
        Some("https://gitlab.corp/g/r/-/merge_requests/12")
    );
    let first = push_options(&env, 0);
    assert!(first.contains("merge_request.create"), "{first}");
    assert!(first.contains("merge_request.target=main"), "{first}");
    assert!(first.contains("merge_request.title=PR"), "{first}");
    assert!(
        first.contains("merge_request.description=") && first.contains("Opened by Code-Automata"),
        "{first}"
    );
    assert!(!env.path("pr-made").exists(), "gh ran");

    // The next push (an update) sends the options again, so GitLab refreshes the description or
    // reopens a merge request that was closed; the link stays. (It may also send nothing at all:
    // a re-squash in the same second is the same commit.)
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(
        pr.url.as_deref(),
        Some("https://gitlab.corp/g/r/-/merge_requests/12")
    );
    let second = push_options(&env, 1);
    assert!(
        second.is_empty() || second.contains("merge_request.create"),
        "{second}"
    );
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(
        t.pull_requests[ROOT_REPO].clone().host,
        Some(ca_core::PrHost::Gitlab)
    );
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the remote hook is a shell script
async fn gitlab_that_reports_no_merge_request_is_an_error_not_up_to_date() {
    let env = Env::new().await;
    let (engine, id) = reviewed_task_on(&env, true, Some(ca_core::PrHost::Gitlab)).await;
    remote_says(&env, "thanks", true);
    let err = engine.create_pull_request(&id).await.unwrap_err();
    assert!(
        err.to_string().contains("printed no merge request"),
        "{err}"
    );
    assert!(
        engine
            .get_task(&id)
            .await
            .unwrap()
            .unwrap()
            .pull_requests
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake gh and the remote hook are shell scripts
async fn a_link_from_another_host_is_not_taken_for_a_github_pr() {
    let env = Env::new().await;
    fake_gh(&env, "echo https://github.com/example/repo/pull/9");
    let (engine, id) = reviewed_task_on(&env, true, None).await;
    remote_says(
        &env,
        "Create a pull request:\n  https://github.com/example/repo/pull/new/x",
        false,
    );
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(pr.host, Some(ca_core::PrHost::Other));
    // Then the project says GitHub: the kept page is not an open PR, so gh opens one.
    use_github(&engine).await;
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(pr.host, Some(ca_core::PrHost::Github));
    assert_eq!(
        pr.url.as_deref(),
        Some("https://github.com/example/repo/pull/9")
    );
    assert!(env.path("pr-made").exists(), "gh pr create did not run");
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the remote hook is a shell script
async fn a_remote_without_push_options_is_named_when_set_to_gitlab() {
    let env = Env::new().await;
    let (engine, id) = reviewed_task_on(&env, true, Some(ca_core::PrHost::Gitlab)).await;
    remote_says(&env, "hello", false);
    let err = engine.create_pull_request(&id).await.unwrap_err();
    assert!(
        err.to_string().contains("set Pull requests to Other"),
        "{err}"
    );
    assert!(
        engine
            .get_task(&id)
            .await
            .unwrap()
            .unwrap()
            .pull_requests
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the remote hook is a shell script
async fn other_hosts_get_the_branch_pushed_and_their_own_link() {
    let env = Env::new().await;
    // A local remote names no host: detected as "other", gh is not needed.
    let (engine, id) = reviewed_task_on(&env, true, None).await;
    remote_says(
        &env,
        "Create pull request for code-automata/x:\n  https://bitbucket.org/o/r/pull-requests/new?source=x",
        false,
    );
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(pr.host, Some(ca_core::PrHost::Other));
    assert_eq!(
        pr.url.as_deref(),
        Some("https://bitbucket.org/o/r/pull-requests/new?source=x")
    );
    let branch = format!("code-automata/{id}");
    assert_eq!(
        git(&env.path("remote.git"), &["rev-parse", &branch]),
        git(&env.worktree(&id), &["rev-parse", "HEAD"])
    );
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the remote hook is a shell script
async fn a_host_that_prints_no_link_still_gets_the_branch() {
    let env = Env::new().await;
    let (engine, id) = reviewed_task_on(&env, true, Some(ca_core::PrHost::Other)).await;
    remote_says(&env, "thanks", false);
    let pr = pushed(engine.create_pull_request(&id).await.unwrap());
    assert_eq!(pr.url, None);
    let t = engine.get_task(&id).await.unwrap().unwrap();
    let recorded = t.pull_requests[ROOT_REPO].clone();
    assert_eq!(recorded.host, Some(ca_core::PrHost::Other));
    assert!(recorded.pushed_checkpoint.is_some());
}

// 5 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_subtask_stops_the_task_and_resume_reruns_only_it() {
    let env = Env::new().await;
    let agent = env.agent(
        3,
        vec![
            json!({ "whenPrompt": "(dev-2)", "onceFile": env.once("fail"), "steps": [
                { "result": { "isError": true, "text": "out of tokens" } }
            ]}),
        ],
    );
    let engine = env.engine().await;
    let task = engine.create_task("Fail", "", agent, false).await.unwrap();
    let t = run_to_end(&engine, &task.id).await;
    let run = t.run.as_ref().unwrap();
    assert_eq!(run.state, RunState::Failed);
    assert_eq!(run.subtask_id.as_deref(), Some("dev-2"));
    assert!(run.error.as_deref().unwrap().contains("out of tokens"));
    assert!(
        env.prompts_with("(dev-3)").is_empty(),
        "nothing after a failure runs"
    );

    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview);
    assert_eq!(env.prompts_with("(dev-1)").len(), 1);
    assert_eq!(env.prompts_with("(dev-3)").len(), 1);
}

// 6 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_hanging_agent_fails_with_a_timeout() {
    let env = Env::new().await;
    env.settings(|s| s.timeouts.idle_minutes = 0.01).await; // 0.6 s
    let agent = env.agent(1, vec![hang_once(&env, "(dev-1)", vec![])]);
    let engine = env.engine().await;
    let task = engine.create_task("Hang", "", agent, false).await.unwrap();
    let t = run_to_end(&engine, &task.id).await;
    let run = t.run.as_ref().unwrap();
    assert_eq!(run.state, RunState::Failed);
    assert!(
        run.error.as_deref().unwrap().contains("timed out"),
        "{run:?}"
    );
}

// 7 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn planning_with_approval_asks_waits_revises_and_leaves_no_files() {
    let env = Env::new().await;
    let agent = env.agent(
        1,
        vec![json!({ "whenPrompt": "# Planning: clarifying questions", "steps": [
            { "spawnChild": { "command": "echo leak > leak.txt" } },
            { "sleepMs": 200 },
            structured(json!({ "questions": [
                { "id": "q1", "text": "Cursor or offset?", "options": ["cursor", "offset"], "required": true }
            ]}))
        ]})],
    );
    let engine = env.engine().await;
    let task = engine
        .create_task("Plan me", "", agent, true)
        .await
        .unwrap();

    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.planning.stage, PlanningStage::Questions);
    assert_eq!(t.planning.questions.len(), 1);
    assert!(
        !env.worktree(&task.id).join("leak.txt").exists(),
        "a planning agent's file survived"
    );

    let unanswered = engine.answer_questions(&task.id, vec![]).await;
    assert!(unanswered.is_err(), "a required question needs an answer");
    engine
        .answer_questions(
            &task.id,
            vec![(
                "q1".into(),
                Answer {
                    choice: Some("cursor".into()),
                    note: None,
                },
            )],
        )
        .await
        .unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(
        t.planning.stage,
        PlanningStage::PlanReady,
        "waits for approval"
    );
    assert!(
        env.prompts_with("# Planning: implementation plan")[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("cursor"),
        "the answer must reach the plan prompt"
    );

    engine.revise_plan(&task.id, "more detail").await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert!(t.planning.plan.as_deref().unwrap().contains("REVISED"));
    assert_eq!(t.planning.stage, PlanningStage::PlanReady);

    engine.approve_plan(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview);
}

// 8 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn failing_checks_start_a_rework_round_with_the_output() {
    let env = Env::new().await;
    env.settings(|s| {
        s.checks = Some(vec![CheckCommand {
            name: "fixed".into(),
            command: if cfg!(windows) {
                "if not exist fixed.txt (echo fixed.txt is missing&& exit 1)".into()
            } else {
                "test -f fixed.txt || (echo fixed.txt is missing; exit 1)".into()
            },
        }]);
    })
    .await;
    let engine = env.engine().await;
    let task = engine
        .create_task("Checks", "", env.agent(1, vec![]), false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    let rework = t.subtask("rework-1").unwrap();
    assert_eq!(rework.rework_round, Some(1));
    assert_eq!(rework.title, "Reworking (1/2)");
    assert!(
        env.prompts_with("(rework-1)")[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("fixed.txt is missing"),
        "the rework prompt must carry the check output"
    );
    assert!(t.review.checks[ROOT_REPO].passed);
    assert_eq!(t.subtask("qa-1").unwrap().status, SubtaskStatus::Done);
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_that_never_pass_end_in_human_review_with_the_findings() {
    let env = Env::new().await;
    env.settings(|s| {
        s.checks = Some(vec![CheckCommand {
            name: "always".into(),
            command: "echo broken&& exit 1".into(),
        }]);
    })
    .await;
    let engine = env.engine().await;
    let task = engine
        .create_task("Never", "", env.agent(1, vec![]), false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);
    assert_eq!(t.review.rework_count, 2);
    assert!(
        t.review
            .feedback
            .as_deref()
            .unwrap()
            .contains("Unresolved after 2")
    );
    let qa = t.subtask("qa-1").unwrap();
    assert_eq!(qa.status, SubtaskStatus::Skipped);
    assert!(qa.skipped_reason.is_some());
}

// 9 ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_qa_verdict_starts_rework_and_qa_changes_are_discarded() {
    let env = Env::new().await;
    let agent = env.agent(
        1,
        vec![json!({ "whenPrompt": "(qa-1)", "onceFile": env.once("qa"), "steps": [
            { "spawnChild": { "command": "echo x > qa-leak.txt&& git add -A&& git -c user.email=q@q -c user.name=q commit -qm qa-commit" } },
            { "sleepMs": 300 },
            structured(json!({ "passed": false, "summary": "broken", "findings": ["the cursor is ignored"] }))
        ]})],
    );
    let engine = env.engine().await;
    let task = engine.create_task("QA", "", agent, false).await.unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    assert!(
        env.prompts_with("(rework-1)")[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("the cursor is ignored")
    );
    assert!(t.subtask("qa-1").unwrap().verdict.as_ref().unwrap().passed);
    let wt = env.worktree(&task.id);
    assert!(!wt.join("qa-leak.txt").exists());
    let log = git(&wt, &["log", "--format=%s"]);
    assert!(
        !log.contains("qa-commit"),
        "a QA agent's commit reached the branch: {log}"
    );
}

// 10 -----------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_second_engine_on_the_same_project_is_refused() {
    let env = Env::new().await;
    let _first = env.engine().await;
    let second = Engine::open(env.project.clone(), env.bins()).await;
    assert!(matches!(second, Err(CoreError::ProjectLocked { .. })));
}

// 11 -----------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn skipping_the_paused_subtask_moves_on_to_the_next() {
    let env = Env::new().await;
    let agent = env.agent(3, vec![hang_once(&env, "(dev-2)", vec![])]);
    let engine = env.engine().await;
    let task = engine.create_task("Skip", "", agent, false).await.unwrap();
    engine.start(&task.id).await.unwrap();
    wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "dev-2 running",
        |t| {
            t.run
                .as_ref()
                .is_some_and(|r| r.subtask_id.as_deref() == Some("dev-2") && r.pid.is_some())
        },
    )
    .await;
    engine.pause(&task.id).await.unwrap();
    let t = engine.skip_subtask(&task.id, "dev-2").await.unwrap();
    assert!(t.run.is_none(), "the skipped subtask's run is over");
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);
    assert_eq!(t.subtask("dev-2").unwrap().status, SubtaskStatus::Skipped);
    assert_eq!(t.subtask("dev-3").unwrap().status, SubtaskStatus::Done);
}

// P3-14 --------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_moved_by_hand_fails_checks_once_instead_of_looping() {
    let env = Env::new().await;
    let engine = env.engine().await;
    let task = engine
        .create_task("Moved", "", env.agent(1, vec![]), false)
        .await
        .unwrap();
    run_to_end(&engine, &task.id).await;

    // Back to AI review with checks due, and a commit made by hand in the worktree.
    let wt = env.worktree(&task.id);
    std::fs::write(wt.join("hand.txt"), "by hand").unwrap();
    git(&wt, &["add", "-A"]);
    git(&wt, &["commit", "-qm", "by hand"]);
    TaskStore::new(engine.project())
        .update(&task.id, |t| {
            t.phase = Phase::AiReview;
            t.review.checks.clear();
            if let Some(q) = t.subtask_mut("qa-1") {
                q.status = SubtaskStatus::Pending;
                q.verdict = None;
                q.finished_at = None;
            }
            Ok(())
        })
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    let run = t.run.as_ref().unwrap();
    assert_eq!(run.kind, RunKind::Checks);
    assert_eq!(run.state, RunState::Failed);
    assert!(
        run.error
            .as_deref()
            .unwrap()
            .contains("not at the last checkpoint"),
        "{run:?}"
    );
}

// Triage (setting, off by default) -----------------------------------------------------------

async fn paused_with_partial_work(env: &Env, verdict: &str) -> (Engine, String) {
    env.settings(|s| s.triage_on_resume = true).await;
    let agent = env.agent(
        2,
        vec![
            json!({ "whenPrompt": "A developer was interrupted", "steps": [
                structured(json!({ "verdict": verdict, "reason": "judged" }))
            ]}),
            hang_once(
                env,
                "(dev-1)",
                vec![json!({ "write": { "path": "partial.txt", "content": "half" } })],
            ),
        ],
    );
    let engine = env.engine().await;
    let task = engine
        .create_task("Triage", "", agent, false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    let wt = env.worktree(&task.id);
    wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "dev-1 running with partial work",
        |t| t.run.as_ref().is_some_and(|r| r.pid.is_some()) && wt.join("partial.txt").exists(),
    )
    .await;
    engine.pause(&task.id).await.unwrap();
    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    (engine, task.id)
}

/// Triage shares the resumed step's run id and attempt; its log must still be its own, so the
/// run list shows each agent run with its own start and outcome.
#[tokio::test(flavor = "multi_thread")]
async fn triage_logs_apart_from_the_resumed_dev_run() {
    let env = Env::new().await;
    let (engine, id) = paused_with_partial_work(&env, "partial").await;
    let runs = engine.run_logs(&id).await.unwrap();
    let triage: Vec<_> = runs.iter().filter(|r| r.label == "triage").collect();
    assert_eq!(triage.len(), 1, "{runs:?}");
    assert_eq!(triage[0].subtask_id.as_deref(), Some("dev-1"));
    let resumed = runs
        .iter()
        .find(|r| {
            r.label == "run" && r.run_id == triage[0].run_id && r.attempt == triage[0].attempt
        })
        .expect("the resumed dev run has its own log");
    assert_ne!(resumed.name, triage[0].name);
    for run in &runs {
        let lines = engine.run_log(&id, &run.name).await.unwrap();
        let starts = lines
            .iter()
            .filter(|l| matches!(l, ca_core::engine::runlog::RunLogLine::Start { .. }))
            .count();
        assert_eq!(starts, 1, "{}: {lines:?}", run.name);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn triage_done_checkpoints_the_partial_work_and_moves_on() {
    let env = Env::new().await;
    let (engine, id) = paused_with_partial_work(&env, "done").await;
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    assert!(
        env.prompts_with("You were interrupted").is_empty(),
        "no resume run needed"
    );
    let wt = env.worktree(&id);
    let files = git(
        &wt,
        &[
            "show",
            "--name-only",
            "--format=",
            t.subtask("dev-1").unwrap().checkpoints[ROOT_REPO].as_str(),
        ],
    );
    assert!(
        files.contains("partial.txt"),
        "the partial work is dev-1's checkpoint: {files}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn triage_broken_discards_the_partial_work_and_redoes_the_subtask() {
    let env = Env::new().await;
    let (engine, id) = paused_with_partial_work(&env, "broken").await;
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    let wt = env.worktree(&id);
    assert!(
        !wt.join("partial.txt").exists(),
        "broken partial work was kept"
    );
    assert_eq!(
        env.prompts_with("# Your subtask: Step 1 (dev-1)").len(),
        2,
        "dev-1 redone from scratch"
    );
    assert_eq!(env.prompts_with("A developer was interrupted").len(), 1);
    assert!(env.prompts_with("You were interrupted").is_empty());
}

// Round-1 review regressions ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_session_resume_starts_fresh_next_time_and_the_agent_cannot_change_mid_step() {
    let env = Env::new().await;
    let agent = env.agent(
        1,
        vec![
            hang_once(&env, "(dev-1)", vec![json!({ "write": { "path": "half.txt", "content": "h" } })]),
            json!({ "whenPrompt": "You were interrupted", "onceFile": env.once("expired"), "steps": [
                { "result": { "isError": true, "text": "session not found" } }
            ]}),
        ],
    );
    let engine = env.engine().await;
    let task = engine
        .create_task("Session", "", agent, false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "dev-1 running",
        |t| {
            t.run
                .as_ref()
                .is_some_and(|r| r.subtask_id.as_deref() == Some("dev-1") && r.pid.is_some())
        },
    )
    .await;
    // The pid is recorded at spawn, before the agent writes; a slow runner (Windows CI) could
    // pause it before the partial work exists, and then there is nothing for the prompt to show.
    let half = env.worktree(&task.id).join("half.txt");
    for _ in 0..200 {
        if half.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(half.exists(), "the agent never wrote its partial work");
    engine.pause(&task.id).await.unwrap();

    let mut patch = serde_json::Map::new();
    patch.insert("agent".into(), json!({ "provider": "cursor" }));
    assert!(
        engine.patch_task(&task.id, &patch).await.is_err(),
        "switching agent under a halted step must be refused"
    );

    // Resume on the stored session fails...
    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.run.as_ref().unwrap().state, RunState::Failed);
    assert!(
        t.run.as_ref().unwrap().session_id.is_none(),
        "the dead session was kept: {:?}",
        t.run
    );
    // ...so the next resume starts a fresh session that still sees the partial work.
    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
    let fresh: Vec<_> = env
        .prompts_with("Resuming an interrupted attempt")
        .into_iter()
        .filter(|r| r["resume"] == false)
        .collect();
    assert_eq!(fresh.len(), 1);
    assert!(fresh[0]["prompt"].as_str().unwrap().contains("half.txt"));
}

#[tokio::test(flavor = "multi_thread")]
async fn pausing_during_checks_stops_them_promptly() {
    let env = Env::new().await;
    let flag = env.path("checked-once");
    env.settings(|s| {
        s.checks = Some(vec![CheckCommand {
            name: "slow".into(),
            command: if cfg!(windows) {
                format!(
                    "if exist \"{f}\" (exit 0) else (type nul > \"{f}\" && ping -n 31 127.0.0.1 > nul)",
                    f = flag.display()
                )
            } else {
                format!(
                    "if [ -f {f} ]; then exit 0; fi; touch {f}; sleep 30",
                    f = flag.display()
                )
            },
        }]);
    })
    .await;
    let engine = env.engine().await;
    let task = engine
        .create_task("Slow checks", "", env.agent(1, vec![]), false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "checks running",
        |t| t.run.as_ref().is_some_and(|r| r.kind == RunKind::Checks),
    )
    .await;
    let began = std::time::Instant::now();
    engine.pause(&task.id).await.unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "pause waited for the check: {:?}",
        began.elapsed()
    );
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.run.as_ref().unwrap().state, RunState::Paused);
    engine.resume(&task.id).await.unwrap();
    engine.wait_idle(&task.id).await;
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::HumanReview, "{t:?}");
}

/// The check's shell starts a process of its own; pausing must kill that grandchild too (a
/// process group on Unix, the Job Object on Windows).
#[tokio::test(flavor = "multi_thread")]
async fn pausing_during_checks_kills_what_the_check_started() {
    let env = Env::new().await;
    let pid_file = env.path("grandchild.pid");
    // The command after it keeps the shell from exec-ing the sleeper in its own place.
    let line = format!(
        "\"{m}\" --sleep-ms 60000 --pid-file \"{f}\" {sep} exit 0",
        m = env!("CARGO_BIN_EXE_mock-agent"),
        f = pid_file.display(),
        sep = if cfg!(windows) { "&" } else { ";" },
    );
    env.settings(|s| {
        s.checks = Some(vec![CheckCommand {
            name: "spawns".into(),
            command: line,
        }]);
    })
    .await;
    let engine = env.engine().await;
    let task = engine
        .create_task("Checks with a grandchild", "", env.agent(1, vec![]), false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    let mut pid = None;
    for _ in 0..400 {
        if let Ok(t) = std::fs::read_to_string(&pid_file)
            && let Ok(p) = t.trim().parse::<u32>()
        {
            pid = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let pid = pid.expect("the check never started its child");
    assert!(alive(pid));

    engine.pause(&task.id).await.unwrap();
    let mut dead = false;
    for _ in 0..100 {
        if !alive(pid) {
            dead = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(dead, "the check's grandchild {pid} outlived the pause");
    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(t.run.as_ref().unwrap().state, RunState::Paused);
}

#[tokio::test(flavor = "multi_thread")]
async fn skipping_a_halted_subtask_drops_its_partial_work() {
    let env = Env::new().await;
    let agent = env.agent(
        2,
        vec![hang_once(
            &env,
            "(dev-1)",
            vec![json!({ "write": { "path": "abandoned.txt", "content": "x" } })],
        )],
    );
    let engine = env.engine().await;
    let task = engine
        .create_task("Skip partial", "", agent, false)
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    let wt = env.worktree(&task.id);
    wait_for(
        &TaskStore::new(engine.project()),
        &task.id,
        "partial work written",
        |_| wt.join("abandoned.txt").exists(),
    )
    .await;
    engine.pause(&task.id).await.unwrap();
    engine.skip_subtask(&task.id, "dev-1").await.unwrap();
    assert!(!wt.join("abandoned.txt").exists());
    let t = run_to_end(&engine, &task.id).await;
    let files = git(
        &wt,
        &[
            "show",
            "--name-only",
            "--format=",
            t.subtask("dev-2").unwrap().checkpoints[ROOT_REPO].as_str(),
        ],
    );
    assert!(
        !files.contains("abandoned.txt"),
        "dev-1's partial work landed in dev-2: {files}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn answering_right_as_the_driver_stops_is_not_lost() {
    for _ in 0..5 {
        let env = Env::new().await;
        let engine = env.engine().await;
        let task = engine
            .create_task("Race", "", env.agent(1, vec![]), true)
            .await
            .unwrap();
        let mut events = engine.subscribe();
        engine.start(&task.id).await.unwrap();
        // Answer the moment the questions are written, while the driver is still leaving.
        loop {
            let _ = events.recv().await;
            let t = engine.get_task(&task.id).await.unwrap().unwrap();
            if t.planning.stage == PlanningStage::Questions {
                break;
            }
        }
        engine
            .answer_questions(
                &task.id,
                vec![(
                    "q1".into(),
                    Answer {
                        choice: Some("cursor".into()),
                        note: None,
                    },
                )],
            )
            .await
            .unwrap();
        engine.wait_idle(&task.id).await;
        let t = engine.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(
            t.planning.stage,
            PlanningStage::PlanReady,
            "the answer was dropped"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn one_bad_task_does_not_stop_the_project_opening() {
    let env = Env::new().await;
    let store = TaskStore::new(&env.project);
    let task = store
        .create(Task::new("Bad", "", env.agent(1, vec![])))
        .await
        .unwrap();
    // Running under some other boot, and invalid: a finished dev subtask with no finish time.
    let path = env.project.tasks_dir().join(&task.id).join("task.json");
    let mut json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    json["phase"] = "in_progress".into();
    json["subtasks"] = json!([
        { "id": "dev-1", "kind": "dev", "title": "a", "detail": "a", "status": "done" },
        { "id": "dev-2", "kind": "dev", "title": "b", "detail": "b", "status": "pending" },
        { "id": "qa-1", "kind": "qa", "title": "q", "detail": "q", "status": "pending" }
    ]);
    json["run"] = json!({ "id": "run-x", "kind": "dev", "state": "running", "subtaskId": "dev-2",
        "attempt": 1, "bootId": "boot-gone", "startedAt": 1, "updatedAt": 1 });
    std::fs::write(&path, json.to_string()).unwrap();

    let engine = env.engine().await;
    assert_eq!(
        engine.reconcile_problems().len(),
        1,
        "{:?}",
        engine.reconcile_problems()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_during_a_running_task_answer_promptly() {
    let env = Env::new().await;
    let agent = env.agent(3, vec![hang_once(&env, "(dev-2)", vec![])]);
    let engine = env.engine().await;
    let task = engine.create_task("Busy", "", agent, false).await.unwrap();
    engine.start(&task.id).await.unwrap();
    // Hit it repeatedly while it moves from planning through dev-1 to dev-2, between-step gaps
    // included: every call must answer within the settle bound, never wait for the task.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        let began = std::time::Instant::now();
        let r = engine.skip_subtask(&task.id, "dev-3").await;
        assert!(
            began.elapsed() < Duration::from_secs(8),
            "a command waited {:?}",
            began.elapsed()
        );
        match r {
            Err(e) if e.to_string().contains("pause the task") => {}
            Err(e) if e.to_string().contains("no subtask") => {} // still planning
            Err(e) => panic!("unexpected error: {e}"),
            Ok(_) => break,
        }
    }
    engine.pause(&task.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake gh is a shell script
async fn a_done_tasks_worktree_can_be_removed_and_comes_back_on_reopen() {
    let env = Env::new().await;
    fake_gh(&env, "echo https://github.com/example/repo/pull/9");
    let (engine, id) = reviewed_task_with_remote(&env, true).await;
    let wt = env.worktree(&id);
    let branch = format!("code-automata/{id}");
    let tip = git(&wt, &["rev-parse", "HEAD"]);

    // Not before the task is done.
    let err = engine.delete_worktree(&id, false).await.unwrap_err();
    assert!(err.to_string().contains("not done"), "{err}");
    assert!(wt.exists());
    let listed = engine.worktrees().await.unwrap();
    assert!(!listed[0].task_done && !listed[0].orphan);

    engine.move_task(&id, Phase::Done).await.unwrap();
    assert!(engine.worktrees().await.unwrap()[0].task_done);
    engine.delete_worktree(&id, false).await.unwrap();
    assert!(!wt.exists(), "the folder is gone");
    assert_eq!(
        git(&env.repo.path, &["rev-parse", &branch]),
        tip,
        "the branch keeps the work"
    );
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(t.phase, Phase::Done, "the task stays");
    assert!(engine.worktrees().await.unwrap().is_empty());
    let err = engine.create_pull_request(&id).await.unwrap_err();
    assert!(err.to_string().contains("reopen"), "{err}");

    // Reopening brings the worktree back on the same branch.
    engine.move_task(&id, Phase::HumanReview).await.unwrap();
    assert!(wt.exists());
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), tip);
    assert_eq!(git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), branch);
    assert_eq!(
        pr_url(&engine, &id).await,
        "https://github.com/example/repo/pull/9"
    );

    // Done again, removed again, then the task deleted: the branch goes with it.
    engine.move_task(&id, Phase::Done).await.unwrap();
    engine.delete_worktree(&id, false).await.unwrap();
    engine.delete_task(&id).await.unwrap();
    assert!(engine.get_task(&id).await.unwrap().is_none());
    let branches = git(&env.repo.path, &["branch", "--list", &branch]);
    assert!(branches.is_empty(), "{branches}");
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_and_restoring_a_done_worktree_guards_the_users_work() {
    let env = Env::new().await;
    let agent = env.agent(1, vec![]);
    let engine = Engine::open(env.project.clone(), env.bins()).await.unwrap();
    let id = engine
        .create_task("Guarded", "", agent, false)
        .await
        .unwrap()
        .id;
    let t = run_to_end(&engine, &id).await;
    assert_eq!(t.phase, Phase::HumanReview);
    engine.move_task(&id, Phase::Done).await.unwrap();
    let wt = env.worktree(&id);
    let branch = format!("code-automata/{id}");

    // Uncommitted changes are not on the branch: refused unless forced.
    std::fs::write(wt.join("hand-edit.txt"), "mine").unwrap();
    let err = engine.delete_worktree(&id, false).await.unwrap_err();
    assert!(err.to_string().contains("uncommitted"), "{err}");
    assert!(wt.exists());
    engine.delete_worktree(&id, true).await.unwrap();
    assert!(!wt.exists());

    // Moving a done task to Done again does not bring the worktree back.
    engine.move_task(&id, Phase::Done).await.unwrap();
    assert!(!wt.exists());

    // A leftover plain folder (a removal that failed partway) is not taken for the worktree:
    // git run in it would act on the main checkout.
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join("leftover.txt"), "x").unwrap();
    engine.move_task(&id, Phase::HumanReview).await.unwrap();
    assert_eq!(git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), branch);
    // Compared as paths: git prints forward slashes on Windows.
    let resolved =
        |p: &std::path::Path| ca_core::util::plain_path(std::fs::canonicalize(p).unwrap());
    assert_eq!(
        resolved(std::path::Path::new(&git(
            &wt,
            &["rev-parse", "--show-toplevel"]
        ))),
        resolved(&wt),
        "the folder is the task's own worktree now"
    );
    assert!(!wt.join("leftover.txt").exists());

    // The branch checked out in the main checkout: reopening says where, instead of git's error.
    engine.move_task(&id, Phase::Done).await.unwrap();
    engine.delete_worktree(&id, false).await.unwrap();
    git(&env.repo.path, &["checkout", "-q", &branch]);
    let err = engine.move_task(&id, Phase::HumanReview).await.unwrap_err();
    assert!(err.to_string().contains("is checked out in"), "{err}");
    let t = engine.get_task(&id).await.unwrap().unwrap();
    assert_eq!(
        t.phase,
        Phase::Done,
        "the refused reopen did not move the task"
    );
    git(&env.repo.path, &["checkout", "-q", "main"]);
    engine.move_task(&id, Phase::HumanReview).await.unwrap();
    assert!(wt.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_never_removes_a_worktree_that_may_hold_the_users_work() {
    let env = Env::new().await;
    let agent = env.agent(1, vec![]);
    let engine = Engine::open(env.project.clone(), env.bins()).await.unwrap();
    let id = engine
        .create_task("Kept", "", agent, false)
        .await
        .unwrap()
        .id;
    assert_eq!(run_to_end(&engine, &id).await.phase, Phase::HumanReview);
    engine.move_task(&id, Phase::Done).await.unwrap();
    let wt = env.worktree(&id);
    let branch = format!("code-automata/{id}");

    // The user switched the done task's worktree to another branch and has work in it.
    git(&wt, &["checkout", "-q", "-b", "my-experiment"]);
    std::fs::write(wt.join("my-work.txt"), "mine").unwrap();
    let err = engine.move_task(&id, Phase::HumanReview).await.unwrap_err();
    assert!(
        err.to_string().contains("is on my-experiment") && err.to_string().contains(&branch),
        "{err}"
    );
    assert!(wt.join("my-work.txt").exists(), "the user's work is kept");
    assert_eq!(
        engine.get_task(&id).await.unwrap().unwrap().phase,
        Phase::Done
    );
    git(&wt, &["checkout", "-q", &branch]);
    std::fs::remove_file(wt.join("my-work.txt")).unwrap();
    engine.move_task(&id, Phase::HumanReview).await.unwrap();

    // A worktree git cannot read (its admin entry gone, a `.git` file pointing nowhere).
    engine.move_task(&id, Phase::Done).await.unwrap();
    engine.delete_worktree(&id, false).await.unwrap();
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), "gitdir: /nonexistent/worktrees/x\n").unwrap();
    std::fs::write(wt.join("my-work.txt"), "mine").unwrap();
    let err = engine.move_task(&id, Phase::HumanReview).await.unwrap_err();
    assert!(err.to_string().contains("could not be read"), "{err}");
    assert!(wt.join("my-work.txt").exists(), "the user's work is kept");
    assert_eq!(
        engine.get_task(&id).await.unwrap().unwrap().phase,
        Phase::Done
    );
}

/// The one repository's pull request of a one-repository task's report.
#[cfg(unix)]
fn pushed(report: ca_core::engine::pr::PrReport) -> ca_core::task::PullRequest {
    match report.rows.into_iter().next().map(|r| r.result) {
        Some(ca_core::engine::pr::PrResult::Pushed { pull_request, .. }) => pull_request,
        other => panic!("expected a pushed pull request, got {other:?}"),
    }
}
