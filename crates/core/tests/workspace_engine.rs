//! The whole engine on a workspace (several repositories in one task), on the mock agent.
#![allow(clippy::unwrap_used)]

mod common;

use std::path::PathBuf;

use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use ca_core::engine::pr::PrResult;
use ca_core::engine::settings::{CheckCommand, RepoSettings, Settings};
use ca_core::git;
use ca_core::{AgentConfig, Phase, PrHost, Provider, Task};
use common::{TempWorkspace, git};
use serde_json::{Value, json};
use tempfile::TempDir;

const PLAN: &str = "# Plan\n\nChange api and web.\n\nPLAN-MARKER";

struct Env {
    ws: TempWorkspace,
    files: TempDir,
}

impl Env {
    async fn new(repos: &[&str]) -> Env {
        let env = Env {
            ws: TempWorkspace::new(repos),
            files: tempfile::tempdir().unwrap(),
        };
        let mut s = Settings::default();
        s.timeouts.idle_minutes = 0.5;
        s.timeouts.total_minutes = 2.0;
        for name in repos {
            s.repos.insert(
                (*name).to_string(),
                RepoSettings {
                    checks: Some(vec![]),
                    pull_request_host: Some(PrHost::Other),
                },
            );
        }
        s.save(&env.ws.project().await).await.unwrap();
        env
    }

    fn path(&self, name: &str) -> PathBuf {
        self.files.path().join(name)
    }

    async fn engine(&self) -> Engine {
        let bins =
            Binaries::from_env().with_override(Provider::Mock, env!("CARGO_BIN_EXE_mock-agent"));
        Engine::open(self.ws.project().await, bins).await.unwrap()
    }

    /// A mock agent with `devs` dev subtasks; `writes[i]` are the files dev-(i+1) writes, relative
    /// to the task folder (so `api/x.txt` lands in the api worktree).
    fn agent(&self, writes: &[&[&str]], qa_writes: &[&str]) -> AgentConfig {
        self.agent_with(writes, qa_writes, vec![])
    }

    /// [`Env::agent`] with `extra` rules played first. Each dev subtask names, as its `repos`, the
    /// repositories it writes to, plus one that does not exist (which must be dropped).
    fn agent_with(&self, writes: &[&[&str]], qa_writes: &[&str], extra: Vec<Value>) -> AgentConfig {
        let mut subtasks: Vec<Value> = writes
            .iter()
            .enumerate()
            .map(|(i, files)| {
                let mut repos: Vec<String> = files
                    .iter()
                    .filter_map(|f| f.split_once('/'))
                    .map(|(r, _)| r.to_string())
                    .collect();
                repos.dedup();
                // Written the way an agent may: `./api/` is api.
                if let Some(first) = repos.first_mut() {
                    *first = format!("./{first}/");
                }
                repos.push("bogus".into());
                let i = i + 1;
                json!({ "id": format!("dev-{i}"), "kind": "dev", "title": format!("Step {i}"), "detail": format!("Do step {i}"), "repos": repos })
            })
            .collect();
        subtasks
            .push(json!({ "id": "qa-1", "kind": "qa", "title": "Verify", "detail": "Check it" }));
        let structured = |v: Value| json!({ "result": { "text": "done", "structured": v } });
        let mut qa_steps: Vec<Value> = qa_writes
            .iter()
            .map(|p| json!({ "write": { "path": p, "content": "qa edit" } }))
            .collect();
        qa_steps.push(structured(
            json!({ "passed": true, "summary": "works", "findings": [] }),
        ));
        let mut rules = extra;
        rules.extend([
            json!({ "whenPrompt": "# Planning: implementation plan", "steps": [structured(json!({ "plan": PLAN }))] }),
            json!({ "whenPrompt": "Break the approved plan", "steps": [structured(json!({ "subtasks": subtasks }))] }),
            json!({ "whenPrompt": "(qa-1)", "steps": qa_steps }),
        ]);
        for (i, files) in writes.iter().enumerate() {
            let id = format!("dev-{}", i + 1);
            let mut steps: Vec<Value> = files
                .iter()
                .map(|p| json!({ "write": { "path": p, "content": format!("{id} wrote {p}") } }))
                .collect();
            steps.push(structured(
                json!({ "summary": format!("did {id}"), "handoff": "" }),
            ));
            rules.push(json!({ "whenPrompt": format!("({id})"), "steps": steps }));
        }
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

    /// The prompts the mock agent got that contain `needle`.
    fn prompts_with(&self, needle: &str) -> Vec<String> {
        std::fs::read_to_string(self.path("record.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter_map(|r| r["prompt"].as_str().map(String::from))
            .filter(|p| p.contains(needle))
            .collect()
    }

    /// A bare remote as `origin` of `repo`.
    fn remote(&self, repo: &str) -> PathBuf {
        let remote = self.path(&format!("{repo}.git"));
        git(
            self.files.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        git(
            &self.ws.repo(repo),
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        remote
    }
}

async fn run_to_end(engine: &Engine, id: &str) -> Task {
    engine.start(id).await.unwrap();
    engine.wait_idle(id).await;
    engine.get_task(id).await.unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_changes_several_repositories_and_gets_one_result_per_repository() {
    let env = Env::new(&["api", "docs", "lib", "web"]).await;
    let api_remote = env.remote("api");
    let web_remote = env.remote("web");
    // docs has no remote; lib is never changed.
    let agent = env.agent(
        &[&["api/a.txt", "web/w.txt"], &["docs/d.txt"], &["stray.txt"]],
        &["api/qa.txt", "web/qa.txt"],
    );
    let engine = env.engine().await;
    let task = engine
        .create_task("Across", "", agent, false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{:?}", t.run);

    // Every repository got a worktree, each on the task branch.
    assert_eq!(t.repos().collect::<Vec<_>>(), ["api", "docs", "lib", "web"]);
    let dir = git::task_dir(engine.project(), &t.id).unwrap();
    for repo in ["api", "docs", "lib", "web"] {
        assert_eq!(
            git(&dir.join(repo), &["rev-parse", "--abbrev-ref", "HEAD"]),
            format!("code-automata/{}", t.id)
        );
    }

    // Checkpoints only where a subtask changed something.
    let dev = |id: &str| t.subtask(id).unwrap().clone();
    assert_eq!(
        dev("dev-1").checkpoints.keys().collect::<Vec<_>>(),
        ["api", "web"]
    );
    assert_eq!(
        dev("dev-2").checkpoints.keys().collect::<Vec<_>>(),
        ["docs"]
    );
    assert!(
        dev("dev-3").checkpoints.is_empty(),
        "the stray file is no repository's"
    );
    assert!(
        dev("dev-3")
            .handoff
            .as_deref()
            .unwrap()
            .contains("stray.txt")
    );
    assert!(!dir.join("stray.txt").exists());
    assert_eq!(t.changed_repos(), ["api", "docs", "web"]);

    // The QA agent's edits were discarded in both repositories.
    assert!(!dir.join("api/qa.txt").exists());
    assert!(!dir.join("web/qa.txt").exists());
    // Checks ran (with no commands) for the changed repositories only.
    assert_eq!(
        t.review.checks.keys().collect::<Vec<_>>(),
        ["api", "docs", "web"]
    );

    let report = engine.create_pull_request(&t.id).await.unwrap();
    let rows: Vec<(&str, &PrResult)> = report
        .rows
        .iter()
        .map(|r| (r.repo.as_str(), &r.result))
        .collect();
    assert!(
        matches!(rows[0], ("api", PrResult::Pushed { .. })),
        "{rows:?}"
    );
    assert!(
        matches!(rows[1], ("docs", PrResult::NoRemote { .. })),
        "{rows:?}"
    );
    assert!(matches!(rows[2], ("lib", PrResult::NoChanges)), "{rows:?}");
    assert!(
        matches!(rows[3], ("web", PrResult::Pushed { .. })),
        "{rows:?}"
    );
    let branch = format!("refs/heads/code-automata/{}", t.id);
    for remote in [&api_remote, &web_remote] {
        let files = git(remote, &["ls-tree", "-r", "--name-only", &branch]);
        assert!(!files.contains("qa.txt"), "{files}");
        assert_eq!(
            git(remote, &["rev-list", "--count", &branch]),
            "2",
            "one squash on the base"
        );
    }
    assert!(git(&api_remote, &["ls-tree", "-r", "--name-only", &branch]).contains("a.txt"));
    assert!(git(&web_remote, &["ls-tree", "-r", "--name-only", &branch]).contains("w.txt"));
    let t = engine.get_task(&t.id).await.unwrap().unwrap();
    assert_eq!(t.pull_requests.keys().collect::<Vec<_>>(), ["api", "web"]);

    // A retry opens nothing twice: both are already up to date.
    let again = engine.create_pull_request(&t.id).await.unwrap();
    assert!(matches!(again.rows[0].result, PrResult::Pushed { .. }));

    // Deleting the task removes every repository's worktree and branch.
    engine.delete_task(&t.id).await.unwrap();
    assert!(!dir.exists());
    for repo in ["api", "docs", "lib", "web"] {
        assert!(git(&env.ws.repo(repo), &["branch", "--list", "code-automata/*"]).is_empty());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_repository_does_not_stop_the_others() {
    let env = Env::new(&["api", "web"]).await;
    env.remote("api");
    let web_remote = env.remote("web");
    // web's remote refuses every push.
    let hook = web_remote.join("hooks/pre-receive");
    #[cfg(unix)]
    common::write_script(&hook, "#!/bin/sh\necho refused >&2\nexit 1\n");
    #[cfg(not(unix))]
    std::fs::write(&hook, "#!/bin/sh\necho refused >&2\nexit 1\n").unwrap();
    let agent = env.agent(&[&["api/a.txt", "web/w.txt"]], &[]);
    let engine = env.engine().await;
    let task = engine
        .create_task("Partial", "", agent, false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);

    let report = engine.create_pull_request(&t.id).await.unwrap();
    assert!(
        matches!(report.rows[0].result, PrResult::Pushed { .. }),
        "{report:?}"
    );
    assert!(
        matches!(report.rows[1].result, PrResult::Failed { .. }),
        "{report:?}"
    );
    let t = engine.get_task(&t.id).await.unwrap().unwrap();
    assert_eq!(
        t.pull_requests.keys().collect::<Vec<_>>(),
        ["api"],
        "the success is kept"
    );

    // Fixed: the retry pushes web, and api is left as it was.
    std::fs::remove_file(&hook).unwrap();
    let report = engine.create_pull_request(&t.id).await.unwrap();
    assert!(
        report
            .rows
            .iter()
            .all(|r| matches!(r.result, PrResult::Pushed { .. })),
        "{report:?}"
    );
    let t = engine.get_task(&t.id).await.unwrap().unwrap();
    assert_eq!(t.pull_requests.keys().collect::<Vec<_>>(), ["api", "web"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repository_that_fails_to_get_a_worktree_rolls_back_the_others() {
    let env = Env::new(&["api", "web"]).await;
    // web already has a branch by the task's name, so its worktree cannot be created.
    let agent = env.agent(&[&["api/a.txt"]], &[]);
    let engine = env.engine().await;
    let task = engine
        .create_task("Rollback", "", agent, false)
        .await
        .unwrap();
    git(
        &env.ws.repo("web"),
        &["branch", &format!("code-automata/{}", task.id)],
    );
    let t = run_to_end(&engine, &task.id).await;
    let error = t
        .run
        .as_ref()
        .and_then(|r| r.error.clone())
        .unwrap_or_default();
    assert!(error.contains("web/"), "{error}");
    assert!(!t.has_worktrees());
    let dir = git::task_dir(engine.project(), &t.id).unwrap();
    assert!(
        !dir.join("api").exists(),
        "api's worktree was removed again"
    );
    assert!(
        git(
            &env.ws.repo("api"),
            &["branch", "--list", "code-automata/*"]
        )
        .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_are_told_the_layout_and_the_planner_names_each_subtasks_repositories() {
    let env = Env::new(&["api", "web"]).await;
    std::fs::write(env.ws.repo("api").join("CLAUDE.md"), "api rules\n").unwrap();
    git(&env.ws.repo("api"), &["add", "-A"]);
    git(&env.ws.repo("api"), &["commit", "-q", "-m", "rules"]);
    std::fs::write(env.ws.path.join("AGENTS.md"), "workspace rules\n").unwrap();
    let agent = env.agent(&[&["api/a.txt"], &["web/w.txt"]], &[]);
    let engine = env.engine().await;
    let task = engine
        .create_task("Layout", "", agent, false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{:?}", t.run);

    assert_eq!(
        t.subtask("dev-1").unwrap().repos,
        ["api"],
        "bogus is dropped"
    );
    assert_eq!(t.subtask("dev-2").unwrap().repos, ["web"]);
    let plan = env.prompts_with("# Planning: implementation plan");
    assert!(plan[0].contains("# Workspace layout"), "{}", plan[0]);
    assert!(plan[0].contains("- `api/`: its instructions are `api/CLAUDE.md`"));
    assert!(plan[0].contains("- `web/`\n"));
    assert!(
        plan[0].contains("AGENTS.md`"),
        "the workspace's own instructions"
    );
    let dev1 = env.prompts_with("(dev-1)");
    assert!(
        dev1[0].contains("this subtask changes: `api/`"),
        "{}",
        dev1[0]
    );

    // What changed, per repository, from the worktrees.
    let changes = engine.changes(&t.id).await.unwrap();
    let names: Vec<_> = changes.iter().map(|c| c.repo.as_str()).collect();
    assert_eq!(names, ["api", "web"]);
    assert_eq!(changes[0].files[0].path, "a.txt");
    assert_eq!(changes[0].files[0].status, git::FileChange::Added);
    assert_eq!(changes[0].files[0].added, Some(1));

    // web's worktree is gone and an empty folder is left where it was: its changes come from the
    // task branch, not from git run in that folder.
    let dir = git::task_dir(engine.project(), &t.id).unwrap();
    let web_wt = dir.join("web");
    git(
        &env.ws.repo("web"),
        &["worktree", "remove", "--force", web_wt.to_str().unwrap()],
    );
    std::fs::create_dir_all(&web_wt).unwrap();
    let changes = engine.changes(&t.id).await.unwrap();
    let web = changes
        .iter()
        .find(|c| c.repo == "web")
        .expect("web is listed");
    assert_eq!(web.files[0].path, "w.txt");
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_failing_in_one_repository_start_a_rework_that_names_it() {
    let env = Env::new(&["api", "web"]).await;
    let project = env.ws.project().await;
    let mut s = Settings::load(&project).await.unwrap();
    s.repos.get_mut("web").unwrap().checks = Some(vec![CheckCommand {
        name: "fixed".into(),
        command: "test -f fixed.txt".into(),
    }]);
    s.save(&project).await.unwrap();
    let rework = json!({ "whenPrompt": "(rework-", "steps": [
        { "write": { "path": "web/fixed.txt", "content": "fixed" } },
        { "result": { "text": "done", "structured": { "summary": "fixed", "handoff": "" } } }
    ]});
    let agent = env.agent_with(&[&["api/a.txt", "web/w.txt"]], &[], vec![rework]);
    let engine = env.engine().await;
    let task = engine
        .create_task("Checks", "", agent, false)
        .await
        .unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{:?}", t.run);
    let rework = t.subtask("rework-1").expect("a rework round");
    assert!(rework.detail.contains("In web/"), "{}", rework.detail);
    assert_eq!(rework.checkpoints.keys().collect::<Vec<_>>(), ["web"]);
    assert!(t.review.checks.values().all(|c| c.passed));
    assert_eq!(t.review.checks.keys().collect::<Vec<_>>(), ["api", "web"]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn github_pull_requests_list_each_other() {
    let env = Env::new(&["api", "web"]).await;
    env.remote("api");
    env.remote("web");
    let project = env.ws.project().await;
    let mut s = Settings::load(&project).await.unwrap();
    for r in s.repos.values_mut() {
        r.pull_request_host = Some(PrHost::Github);
    }
    s.save(&project).await.unwrap();
    // A fake gh: each repository's PR is named after its folder; edits are logged.
    let gh = env.path("gh");
    let log = env.path("gh-edits");
    common::write_script(
        &gh,
        &format!(
            "#!/bin/sh\nrepo=$(basename \"$PWD\")\ncase \"$1 $2\" in\n\
             \"pr view\") exit 1 ;;\n\
             \"pr create\") echo https://github.com/o/$repo/pull/1 ;;\n\
             \"pr edit\") printf '%s\\n---\\n' \"$repo: $*\" >> {log} ;;\n\
             esac\n",
            log = log.display()
        ),
    );
    let agent = env.agent(&[&["api/a.txt", "web/w.txt"]], &[]);
    let bins = Binaries::from_env()
        .with_override(Provider::Mock, env!("CARGO_BIN_EXE_mock-agent"))
        .with_tool("gh", &gh);
    let engine = Engine::open(project, bins).await.unwrap();
    let task = engine.create_task("Links", "", agent, false).await.unwrap();
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview);

    let report = engine.create_pull_request(&t.id).await.unwrap();
    assert!(
        report
            .rows
            .iter()
            .all(|r| matches!(r.result, PrResult::Pushed { .. })),
        "{report:?}"
    );
    let edits = std::fs::read_to_string(&log).unwrap();
    let api_edit = edits
        .split("---")
        .find(|e| e.trim_start().starts_with("api:"))
        .unwrap();
    let web_edit = edits
        .split("---")
        .find(|e| e.trim_start().starts_with("web:"))
        .unwrap();
    assert!(
        api_edit.contains("Part of a change across") && api_edit.contains("o/web/pull/1"),
        "{api_edit}"
    );
    assert!(web_edit.contains("o/api/pull/1"), "{web_edit}");
    let api_links = api_edit.split("Part of a change across").nth(1).unwrap();
    assert!(
        !api_links.contains("o/api/pull/1"),
        "a PR does not list itself: {api_edit}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_worktree_list_survives_a_repository_that_is_gone_and_sees_a_new_one() {
    let env = Env::new(&["api", "web"]).await;
    let agent = env.agent(&[&["api/a.txt"]], &[]);
    let engine = env.engine().await;
    let task = engine.create_task("Gone", "", agent, false).await.unwrap();
    // A repository added after the engine opened gets the task's worktree too.
    std::fs::create_dir_all(env.ws.repo("lib")).unwrap();
    common::init_repo(&env.ws.repo("lib"));
    let t = run_to_end(&engine, &task.id).await;
    assert_eq!(t.phase, Phase::HumanReview, "{:?}", t.run);
    assert_eq!(t.repos().collect::<Vec<_>>(), ["api", "lib", "web"]);
    let listed: Vec<String> = engine
        .worktrees()
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.worktree.repo)
        .collect();
    assert_eq!(listed, ["api", "lib", "web"]);

    // web's main checkout is moved away: the list still works and shows the rest.
    std::fs::rename(env.ws.repo("web"), env.path("web-moved")).unwrap();
    let listed: Vec<String> = engine
        .worktrees()
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.worktree.repo)
        .collect();
    assert_eq!(listed, ["api", "lib"]);
}
