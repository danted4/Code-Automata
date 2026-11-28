//! The HTTP API end to end, on the mock agent. Requests go through the real router (auth
//! included) with `tower::ServiceExt::oneshot`.
//!
//! The mock agent is core's `mock-agent` binary, which `cargo test` at the workspace root builds;
//! with `-p code-automata-server` alone, build it first (`cargo build -p code-automata-core`).
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use ca_core::engine::settings::Settings;
use ca_core::git::Worktrees;
use ca_core::{ProjectDir, Provider};
use ca_server::{AppState, Config};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "test-token";
const PORT: u16 = 7999;

fn mock_agent() -> PathBuf {
    // The final binaries sit in target/<profile>/. Test executables are below it, in deps/ or
    // (newer Cargo) build/<package>/<hash>/, so look in each folder above this one.
    let name = format!("mock-agent{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().unwrap();
    exe.ancestors()
        .skip(1)
        .map(|dir| dir.join(&name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            panic!(
                "no {name} above {}: run `cargo build -p code-automata-core` (or `cargo test` at \
                 the workspace root)",
                exe.display()
            )
        })
}

fn git(cwd: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A throwaway repository with one commit, no automatic checks and short timeouts.
/// The same agent for every phase, as a task's `agents`.
fn same(agent: Value) -> Value {
    json!({ "planning": agent, "dev": agent, "qa": agent })
}

struct Repo {
    _dir: TempDir,
    path: PathBuf,
}

impl Repo {
    async fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = ca_core::util::plain_path(std::fs::canonicalize(dir.path()).unwrap());
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "Test"]);
        git(&path, &["config", "user.email", "test@example.com"]);
        git(&path, &["config", "commit.gpgsign", "false"]);
        std::fs::write(path.join("README.md"), "# test\n").unwrap();
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-q", "-m", "init"]);
        let mut settings = Settings {
            checks: Some(vec![]),
            ..Settings::default()
        };
        settings.timeouts.idle_minutes = 0.5;
        settings.timeouts.total_minutes = 2.0;
        settings
            .save(&ProjectDir::open(&path).await.unwrap())
            .await
            .unwrap();
        Repo { _dir: dir, path }
    }
}

struct Harness {
    state: Arc<AppState>,
    app: Router,
    files: TempDir,
}

impl Harness {
    fn new(allow_mock: bool) -> Harness {
        Self::with_bins(
            allow_mock,
            Binaries::from_env().with_override(Provider::Mock, mock_agent()),
        )
    }

    fn with_bins(allow_mock: bool, bins: Binaries) -> Harness {
        let state = AppState::new(Config {
            token: TOKEN.into(),
            port: PORT,
            allow_mock,
            mock_scenario: None,
            bins,
            allowed_origins: Vec::new(),
            wake_timing: ca_core::engine::limits::WakeTiming::default(),
        });
        Harness {
            app: ca_server::router(state.clone()),
            state,
            files: tempfile::tempdir().unwrap(),
        }
    }

    fn request(
        &self,
        method: &str,
        uri: &str,
        project: Option<&Path>,
        body: Option<Value>,
    ) -> Request<Body> {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("authorization", format!("Bearer {TOKEN}"));
        if let Some(p) = project {
            let encoded = percent_encoding::utf8_percent_encode(
                p.to_str().unwrap(),
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
            req = req.header("x-project-path", encoded);
        }
        match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string()))
                .unwrap(),
            None => req.body(Body::empty()).unwrap(),
        }
    }

    async fn send(&self, req: Request<Body>) -> (StatusCode, Value) {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
        };
        (status, value)
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        project: &Path,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        self.send(self.request(method, uri, Some(project), body))
            .await
    }

    async fn ok(&self, method: &str, uri: &str, project: &Path, body: Option<Value>) -> Value {
        let (status, value) = self.call(method, uri, project, body).await;
        assert!(status.is_success(), "{method} {uri}: {status} {value}");
        value
    }

    /// A mock agent for `devs` dev subtasks and one QA subtask, with `extra` rules played first.
    fn agent(&self, devs: usize, extra: Vec<Value>) -> Value {
        let mut rules = extra;
        rules.extend(standard_rules(devs));
        let scenario = self
            .files
            .path()
            .join(format!("scenario-{}.json", ca_core::util::now_ms()));
        std::fs::write(
            &scenario,
            json!({ "rules": rules, "steps": [
                { "result": { "isError": true, "text": "no rule matched this prompt" } }
            ]})
            .to_string(),
        )
        .unwrap();
        json!({ "provider": "mock", "options": { "scenario": scenario.to_str().unwrap() } })
    }

    fn once_file(&self, name: &str) -> String {
        self.files
            .path()
            .join(format!("once-{name}"))
            .to_string_lossy()
            .into_owned()
    }

    async fn create(&self, project: &Path, title: &str, agent: Value, approval: bool) -> String {
        let (status, task) = self
            .call(
                "POST",
                "/api/tasks",
                project,
                Some(json!({ "title": title, "agents": same(agent), "requirePlanApproval": approval })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{task}");
        task["id"].as_str().unwrap().to_string()
    }

    async fn wait_for(
        &self,
        project: &Path,
        id: &str,
        what: &str,
        pred: impl Fn(&Value) -> bool,
    ) -> Value {
        let mut last = Value::Null;
        for _ in 0..600 {
            let (status, task) = self
                .call("GET", &format!("/api/tasks/{id}"), project, None)
                .await;
            if status == StatusCode::OK && pred(&task) {
                return task;
            }
            last = task;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}; task: {last}");
    }
}

const PLAN: &str =
    "# Plan\n\n## Overview\nDo it.\n\n## Implementation Steps\n1. one\n2. two\n\nPLAN-MARKER";

/// Write an executable script that the test then runs. Not `std::fs::write`: a child forked by
/// another test thread while this process holds the file open for writing keeps that descriptor
/// until it execs, and running the script meanwhile fails with ETXTBSY (Linux). A child `sh`
/// writes it instead (as `write_script` in core's `tests/common`).
#[cfg(unix)]
fn write_script(path: &Path, contents: &str) {
    use std::io::Write;
    let mut child = std::process::Command::new("sh")
        .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
        .arg(path)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // If sh fails early (a missing folder) this write fails too; the assert below names the file.
    let _ = child.stdin.take().unwrap().write_all(contents.as_bytes());
    assert!(
        child.wait().unwrap().success(),
        "writing {}",
        path.display()
    );
}

fn structured(v: Value) -> Value {
    json!({ "result": { "text": "done", "structured": v } })
}

fn standard_rules(devs: usize) -> Vec<Value> {
    let mut subtasks: Vec<Value> = (1..=devs)
        .map(|i| json!({ "id": format!("dev-{i}"), "kind": "dev", "title": format!("Step {i}"), "detail": format!("Do step {i}") }))
        .collect();
    subtasks.push(json!({ "id": "qa-1", "kind": "qa", "title": "Verify", "detail": "Check it" }));
    let mut rules = vec![
        json!({ "whenPrompt": "You were interrupted before finishing", "steps": [
            structured(json!({ "summary": "resumed", "handoff": "note" }))
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
        json!({ "whenPrompt": "(qa-1)", "steps": [
            structured(json!({ "passed": true, "summary": "works", "findings": [] }))
        ]}),
    ];
    for i in 1..=devs {
        rules.push(json!({ "whenPrompt": format!("(dev-{i})"), "steps": [
            { "write": { "path": format!("dev-{i}.txt"), "content": format!("dev {i}") } },
            structured(json!({ "summary": format!("did dev-{i}"), "handoff": format!("note {i}") }))
        ]}));
    }
    rules
}

fn phase(task: &Value) -> &str {
    task["phase"].as_str().unwrap_or("")
}

fn run_state(task: &Value) -> Option<&str> {
    task["run"]["state"].as_str()
}

// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn every_request_needs_the_token_and_the_right_host() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let project = repo.path.to_str().unwrap().to_string();

    let bare = Request::builder()
        .uri("/api/tasks")
        .header("host", format!("127.0.0.1:{PORT}"))
        .header("x-project-path", &project)
        .body(Body::empty())
        .unwrap();
    let (status, body) = h.send(bare).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthorized");

    let wrong = Request::builder()
        .uri("/api/tasks")
        .header("host", format!("127.0.0.1:{PORT}"))
        .header("authorization", "Bearer nope")
        .body(Body::empty())
        .unwrap();
    assert_eq!(h.send(wrong).await.0, StatusCode::UNAUTHORIZED);

    for host in [
        "evil.example:7999".to_string(),
        format!("127.0.0.1:{}", PORT + 1),
    ] {
        let req = Request::builder()
            .uri("/api/tasks")
            .header("host", host)
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap();
        let (status, body) = h.send(req).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "bad_host");
    }

    let mut ok = h.request("GET", "/api/tasks", Some(&repo.path), None);
    ok.headers_mut()
        .insert("host", format!("localhost:{PORT}").parse().unwrap());
    let (status, body) = h.send(ok).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["tasks"], json!([]));
}

/// The desktop app's page calls the server cross-origin. Only its own origin gets CORS headers,
/// a preflight needs no token, and every real request still does.
#[tokio::test(flavor = "multi_thread")]
async fn only_the_app_origin_may_call_cross_origin_and_still_needs_the_token() {
    const APP: &str = "tauri://localhost";
    let state = AppState::new(Config {
        token: TOKEN.into(),
        port: PORT,
        allow_mock: false,
        mock_scenario: None,
        bins: Binaries::from_env(),
        allowed_origins: vec![APP.into()],
        wake_timing: ca_core::engine::limits::WakeTiming::default(),
    });
    let app = ca_server::router(state);
    let send = |req: Request<Body>| {
        let app = app.clone();
        async move { app.oneshot(req).await.unwrap() }
    };
    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/providers")
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("origin", origin)
            .header("access-control-request-method", "GET")
            .header(
                "access-control-request-headers",
                "authorization,x-project-path",
            )
            .body(Body::empty())
            .unwrap()
    };

    let res = send(preflight(APP)).await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let h = res.headers();
    assert_eq!(h["access-control-allow-origin"], APP);
    assert!(
        h["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("x-project-path")
    );

    let res = send(preflight("https://evil.example")).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!res.headers().contains_key("access-control-allow-origin"));

    // A preflight still has to name this server.
    let mut wrong_host = preflight(APP);
    wrong_host
        .headers_mut()
        .insert("host", "evil.example:7999".parse().unwrap());
    assert_eq!(send(wrong_host).await.status(), StatusCode::FORBIDDEN);

    // From the app's origin without the token: refused, but readable by the page.
    let res = send(
        Request::builder()
            .uri("/api/providers")
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("origin", APP)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(res.headers()["access-control-allow-origin"], APP);

    let res = send(
        Request::builder()
            .uri("/api/providers")
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("origin", APP)
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["access-control-allow-origin"], APP);

    // Another origin with the token works as without any origin (the browser would hide the
    // answer), and gets no CORS header.
    let res = send(
        Request::builder()
            .uri("/api/providers")
            .header("host", format!("127.0.0.1:{PORT}"))
            .header("origin", "https://evil.example")
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(!res.headers().contains_key("access-control-allow-origin"));
}

/// `ca-server` (no allowed origins) never sends CORS headers, preflight or not.
#[tokio::test(flavor = "multi_thread")]
async fn the_plain_server_sends_no_cors_headers() {
    let h = Harness::new(false);
    let mut req = h.request("GET", "/api/providers", None, None);
    req.headers_mut()
        .insert("origin", "tauri://localhost".parse().unwrap());
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!res.headers().contains_key("access-control-allow-origin"));
}

/// Open projects are listed by repository root, for the desktop app's path checks.
#[tokio::test(flavor = "multi_thread")]
async fn open_roots_lists_opened_projects() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    assert!(h.state.open_roots().await.is_empty());
    h.ok("GET", "/api/tasks", &repo.path, None).await;
    assert_eq!(h.state.open_roots().await, vec![repo.path.clone()]);
    assert_eq!(h.state.running_count().await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_are_checked_and_a_project_open_elsewhere_is_refused() {
    let h = Harness::new(true);
    let repo = Repo::new().await;

    let (status, body) = h.send(h.request("GET", "/api/tasks", None, None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let plain = tempfile::tempdir().unwrap();
    let (status, body) = h.call("GET", "/api/tasks", plain.path(), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_project");

    // A subfolder of a repository is refused; its root opens.
    let sub = repo.path.join("src").join("deep");
    std::fs::create_dir_all(&sub).unwrap();
    let (status, body) = h
        .call(
            "POST",
            "/api/projects/open",
            &repo.path,
            Some(json!({ "path": sub })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "invalid_project");
    let opened = h
        .ok(
            "POST",
            "/api/projects/open",
            &repo.path,
            Some(json!({ "path": repo.path })),
        )
        .await;
    assert_eq!(opened["root"], json!(repo.path));
    assert_eq!(opened["kind"], "repo");
    assert_eq!(opened["repos"], json!(["."]));
    assert_eq!(opened["reconcileProblems"], json!([]));

    // Another app holding the project.
    let other = Repo::new().await;
    let _held = Engine::open(
        ProjectDir::open(&other.path).await.unwrap(),
        Binaries::from_env(),
    )
    .await
    .unwrap();
    let (status, body) = h
        .call(
            "POST",
            "/api/projects/open",
            &other.path,
            Some(json!({ "path": other.path })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "project_locked");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_of_repositories_opens_as_a_workspace_and_is_checked_on_every_open() {
    let h = Harness::new(true);
    let ws = tempfile::tempdir().unwrap();
    let root = ca_core::util::plain_path(std::fs::canonicalize(ws.path()).unwrap());
    for name in ["web", "api"] {
        let repo = root.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@x",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
    }
    let body = json!({ "path": root });
    let opened = h
        .ok("POST", "/api/projects/open", &root, Some(body.clone()))
        .await;
    assert_eq!(opened["root"], json!(root));
    assert_eq!(opened["kind"], "workspace");
    assert_eq!(opened["repos"], json!(["api", "web"]));
    h.ok("GET", "/api/tasks", &root, None).await;

    // A folder that is not a repository appears: the next open is refused, naming it, although
    // the engine is already open.
    std::fs::create_dir_all(root.join("notes")).unwrap();
    let (status, err) = h
        .call("POST", "/api/projects/open", &root, Some(body))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert!(err["error"].as_str().unwrap().contains("notes"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workspace_task_reports_its_changes_and_one_pull_request_row_per_repository() {
    let h = Harness::new(true);
    let ws = tempfile::tempdir().unwrap();
    let root = ca_core::util::plain_path(std::fs::canonicalize(ws.path()).unwrap());
    for name in ["api", "web"] {
        let repo = root.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@x",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
    }
    let write_api = json!({ "whenPrompt": "(dev-1)", "steps": [
        { "write": { "path": "api/x.txt", "content": "x" } },
        structured(json!({ "summary": "did", "handoff": "" }))
    ]});
    let id = h
        .create(&root, "Across", h.agent(1, vec![write_api]), false)
        .await;
    let task = h
        .wait_for(&root, &id, "human review", |t| {
            phase(t) == "human_review" && t["run"].is_null()
        })
        .await;
    assert_eq!(task["baseCommits"].as_object().unwrap().len(), 2, "{task}");

    let changes = h
        .ok("GET", &format!("/api/tasks/{id}/changes"), &root, None)
        .await;
    assert_eq!(changes[0]["repo"], "api", "{changes}");
    assert_eq!(changes[0]["files"][0]["path"], "x.txt");
    assert_eq!(changes[0]["files"][0]["status"], "added");
    assert_eq!(changes[0]["hasRemote"], false, "{changes}");
    assert_eq!(changes.as_array().unwrap().len(), 1);

    let report = h
        .ok(
            "POST",
            &format!("/api/tasks/{id}/pull-requests"),
            &root,
            None,
        )
        .await;
    assert_eq!(report["rows"][0]["repo"], "api", "{report}");
    assert_eq!(report["rows"][0]["result"]["result"], "no_remote");
    assert_eq!(report["rows"][1]["repo"], "web");
    assert_eq!(report["rows"][1]["result"]["result"], "no_changes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repository_without_a_remote_is_reported_not_pushed() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let id = h
        .create(&repo.path, "No remote", h.agent(1, vec![]), false)
        .await;
    h.wait_for(&repo.path, &id, "human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
    let report = h
        .ok(
            "POST",
            &format!("/api/tasks/{id}/pull-requests"),
            &repo.path,
            None,
        )
        .await;
    assert_eq!(report["rows"][0]["repo"], ".", "{report}");
    assert_eq!(
        report["rows"][0]["result"]["result"], "no_remote",
        "{report}"
    );
    let task = h
        .ok("GET", &format!("/api/tasks/{id}"), &repo.path, None)
        .await;
    assert!(
        task.get("pullRequests").is_none(),
        "nothing recorded: {task}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_from_creation_to_human_review_and_its_runs_replay() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let id = h
        .create(&repo.path, "Two steps", h.agent(2, vec![]), false)
        .await;
    let task = h
        .wait_for(&repo.path, &id, "human review", |t| {
            phase(t) == "human_review" && t["run"].is_null()
        })
        .await;
    let subtasks = task["subtasks"].as_array().unwrap();
    assert_eq!(subtasks.len(), 3);
    assert!(subtasks.iter().all(|s| s["status"] == "done"), "{task}");
    assert_eq!(subtasks[0]["handoff"], "note 1");

    let list = h.ok("GET", "/api/tasks", &repo.path, None).await;
    assert_eq!(list["tasks"][0]["id"], json!(id));

    let runs = h
        .ok("GET", &format!("/api/tasks/{id}/runs"), &repo.path, None)
        .await;
    let runs = runs.as_array().unwrap();
    // plan, subtask generation, two dev subtasks and one QA subtask
    assert_eq!(runs.len(), 5, "{runs:?}");
    assert!(
        runs.iter().all(|r| r["outcome"]["kind"] == "completed"),
        "{runs:?}"
    );
    let dev = runs.iter().find(|r| r["subtaskId"] == "dev-1").unwrap();
    assert_eq!(dev["kind"], "dev");
    assert_eq!(dev["provider"], "mock");

    let name = dev["name"].as_str().unwrap();
    let lines = h
        .ok(
            "GET",
            &format!("/api/tasks/{id}/runs/{name}"),
            &repo.path,
            None,
        )
        .await;
    let lines = lines.as_array().unwrap();
    assert_eq!(lines[0]["line"], "start");
    assert_eq!(lines[0]["subtaskId"], "dev-1");
    // Events are numbered 1, 2, ... in their log; live events carry the same numbers.
    let seqs: Vec<u64> = lines[1..]
        .iter()
        .map(|l| l["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
    let last = lines.last().unwrap();
    assert_eq!(last["line"], "event");
    assert_eq!(last["event"]["type"], "finished");
    assert_eq!(last["event"]["outcome"]["kind"], "completed");

    let (status, _) = h
        .call(
            "GET",
            &format!("/api/tasks/{id}/runs/no-such-run"),
            &repo.path,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = h
        .call(
            "GET",
            &format!("/api/tasks/{id}/runs/..%2Fx"),
            &repo.path,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn planning_with_approval_goes_through_answers_revision_edit_and_approval() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let id = h
        .create(&repo.path, "Paging", h.agent(1, vec![]), true)
        .await;
    let p = &repo.path;

    h.wait_for(p, &id, "questions", |t| {
        t["planning"]["stage"] == "questions" && t["run"].is_null()
    })
    .await;
    let (status, body) = h
        .call(
            "POST",
            &format!("/api/tasks/{id}/answers"),
            p,
            Some(json!({ "answers": {} })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a required answer is missing: {body}"
    );
    h.ok(
        "POST",
        &format!("/api/tasks/{id}/answers"),
        p,
        Some(json!({ "answers": { "q1": { "choice": "cursor" } } })),
    )
    .await;

    h.wait_for(p, &id, "plan", |t| {
        t["planning"]["stage"] == "plan_ready" && t["run"].is_null()
    })
    .await;
    h.ok(
        "POST",
        &format!("/api/tasks/{id}/plan/revise"),
        p,
        Some(json!({ "feedback": "shorter" })),
    )
    .await;
    h.wait_for(p, &id, "revised plan", |t| {
        t["planning"]["plan"]
            .as_str()
            .is_some_and(|s| s.contains("REVISED"))
            && t["run"].is_null()
    })
    .await;

    let edited = format!("{PLAN}\n\nEDITED BY HAND");
    let task = h
        .ok(
            "PUT",
            &format!("/api/tasks/{id}/plan"),
            p,
            Some(json!({ "plan": edited })),
        )
        .await;
    assert!(
        task["planning"]["plan"]
            .as_str()
            .unwrap()
            .contains("EDITED BY HAND")
    );

    h.ok("POST", &format!("/api/tasks/{id}/plan/approve"), p, None)
        .await;
    h.wait_for(p, &id, "human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_and_resume_continue_the_same_subtask() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let hang = json!({ "whenPrompt": "(dev-1)", "onceFile": h.once_file("dev-1"), "steps": [
        { "text": "working" }, { "hang": true }
    ]});
    let id = h
        .create(&repo.path, "Pause me", h.agent(2, vec![hang]), false)
        .await;
    let p = &repo.path;
    h.wait_for(p, &id, "dev-1 running", |t| {
        t["run"]["subtaskId"] == "dev-1"
            && run_state(t) == Some("running")
            && t["run"]["pid"].is_number()
    })
    .await;

    let task = h
        .ok("POST", &format!("/api/tasks/{id}/pause"), p, None)
        .await;
    assert_eq!(run_state(&task), Some("paused"), "{task}");
    assert_eq!(task["run"]["subtaskId"], "dev-1");
    assert_eq!(phase(&task), "in_progress");

    let (status, _) = h
        .call("POST", &format!("/api/tasks/{id}/start"), p, None)
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a paused task is resumed, not started"
    );

    h.ok("POST", &format!("/api/tasks/{id}/resume"), p, None)
        .await;
    h.wait_for(p, &id, "human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_requests_are_400_and_refused_moves_409() {
    let h = Harness::new(false);
    let repo = Repo::new().await;
    let p = &repo.path;

    let (status, body) = h
        .call(
            "POST",
            "/api/tasks",
            p,
            Some(json!({ "title": "x", "agents": same(json!({ "provider": "mock" })) })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "mock is not offered: {body}"
    );

    let (status, body) = h
        .call("POST", "/api/tasks", p, Some(json!({ "title": 5 })))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "bad_request");

    let created = h
        .ok(
            "POST",
            "/api/tasks",
            p,
            Some(json!({ "title": "Idle", "agents": same(json!({ "provider": "claude" })), "start": false })),
        )
        .await;
    let id = created["id"].as_str().unwrap();

    let (status, body) = h
        .call(
            "PATCH",
            &format!("/api/tasks/{id}"),
            p,
            Some(json!({ "phase": "done" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = h
        .call(
            "PATCH",
            &format!("/api/tasks/{id}"),
            p,
            Some(json!({ "agents": same(json!({ "provider": "mock" })) })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let task = h
        .ok(
            "PATCH",
            &format!("/api/tasks/{id}"),
            p,
            Some(json!({ "title": "Renamed" })),
        )
        .await;
    assert_eq!(task["title"], "Renamed");

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/tasks/{id}/move"),
            p,
            Some(json!({ "to": "done" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "invalid_move");

    let (status, body) = h.call("GET", "/api/tasks/task-nope", p, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = h.call("GET", "/api/nothing-here", p, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");

    let (status, _) = h.call("DELETE", &format!("/api/tasks/{id}"), p, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = h.call("GET", &format!("/api/tasks/{id}"), p, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Read SSE `data:` messages from a streaming body until `want` has seen what it needs.
async fn read_events(body: &mut Body, mut want: impl FnMut(&Value) -> bool) {
    let mut buf = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let frame = tokio::time::timeout_at(deadline, body.frame())
            .await
            .expect("timed out waiting for events")
            .expect("stream ended")
            .unwrap();
        if let Ok(data) = frame.into_data() {
            buf.push_str(&String::from_utf8_lossy(&data));
        }
        while let Some(end) = buf.find("\n\n") {
            let message: String = buf.drain(..end + 2).collect();
            for line in message.lines() {
                if let Some(json) = line.strip_prefix("data: ")
                    && want(&serde_json::from_str(json).unwrap())
                {
                    return;
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_event_stream_says_hello_then_carries_task_changes_and_agent_output() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let res = h
        .app
        .clone()
        .oneshot(h.request("GET", "/api/events", Some(&repo.path), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    read_events(&mut body, |m| m["type"] == "hello").await;

    let id = h
        .create(&repo.path, "Watched", h.agent(1, vec![]), false)
        .await;
    let (mut saw_task, mut saw_agent, mut saw_review) = (false, false, false);
    read_events(&mut body, |m| {
        if m["taskId"] == json!(id) {
            match m["type"].as_str() {
                Some("task") => {
                    saw_task = true;
                    saw_review |= m["task"]["phase"] == "human_review";
                }
                Some("agent") => {
                    assert!(m["seq"].as_u64().is_some_and(|n| n >= 1), "{m}");
                    assert!(
                        m["log"].as_str().is_some_and(|l| l.starts_with("run-")),
                        "{m}"
                    );
                    saw_agent |= m["event"]["type"] == "text" || m["event"]["type"] == "finished"
                }
                _ => {}
            }
        }
        saw_task && saw_agent && saw_review
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn worktrees_are_listed_and_only_orphans_deleted() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let p = &repo.path;
    let id = h
        .create(p, "Has a worktree", h.agent(1, vec![]), false)
        .await;
    h.wait_for(p, &id, "human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
    Worktrees::new(ProjectDir::open(p).await.unwrap())
        .create("orphan-1")
        .await
        .unwrap();

    let list = h.ok("GET", "/api/worktrees", p, None).await;
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2, "{list:?}");
    let own = list.iter().find(|w| w["taskId"] == json!(id)).unwrap();
    assert_eq!(own["taskTitle"], "Has a worktree");
    let orphan = list.iter().find(|w| w["taskId"] == "orphan-1").unwrap();
    assert!(orphan["taskTitle"].is_null());

    let usage = h.ok("GET", "/api/worktrees/usage", p, None).await;
    assert!(usage["totalBytes"].as_f64().unwrap() > 0.0);

    let (status, body) = h
        .call("DELETE", &format!("/api/worktrees/{id}"), p, None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    h.ok("DELETE", "/api/worktrees/orphan-1", p, None).await;
    let list = h.ok("GET", "/api/worktrees", p, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["taskDone"], false);

    // Once the task is done its worktree can go; uncommitted changes need ?force=true.
    h.ok(
        "POST",
        &format!("/api/tasks/{id}/move"),
        p,
        Some(json!({ "to": "done" })),
    )
    .await;
    let list = h.ok("GET", "/api/worktrees", p, None).await;
    assert_eq!(list[0]["taskDone"], true);
    let wt = list[0]["path"].as_str().unwrap().to_string();
    std::fs::write(Path::new(&wt).join("hand-edit.txt"), "mine").unwrap();
    let (status, body) = h
        .call("DELETE", &format!("/api/worktrees/{id}"), p, None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("uncommitted"),
        "{body}"
    );
    h.ok(
        "DELETE",
        &format!("/api/worktrees/{id}?force=true"),
        p,
        None,
    )
    .await;
    assert!(!Path::new(&wt).exists());
    let task = h.ok("GET", &format!("/api/tasks/{id}"), p, None).await;
    assert_eq!(phase(&task), "done", "the task stays");
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_round_trip_with_the_default_prompts() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let p = &repo.path;
    let got = h.ok("GET", "/api/settings", p, None).await;
    assert!(!got["promptDefaults"]["plan"].as_str().unwrap().is_empty());
    assert!(
        !got["promptDefaults"]["subtasks"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    assert_eq!(got["settings"]["schema"], 1);

    let mut settings = got["settings"].clone();
    settings["maxConcurrentAgents"] = json!(0);
    let (status, body) = h
        .call("PUT", "/api/settings", p, Some(settings.clone()))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    settings["maxConcurrentAgents"] = json!(3);
    settings["checks"] = json!([{ "name": "lint", "command": "echo ok" }]);
    settings["prompts"] = json!({ "plan": "My plan template" });
    h.ok("PUT", "/api/settings", p, Some(settings)).await;
    let got = h.ok("GET", "/api/settings", p, None).await;
    assert_eq!(got["settings"]["maxConcurrentAgents"], 3);
    assert_eq!(got["settings"]["checks"][0]["name"], "lint");
    assert_eq!(got["settings"]["prompts"]["plan"], "My plan template");
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)] // the fake CLI is a shell script
async fn an_agent_cli_file_can_be_chosen_and_cleared() {
    let h = Harness::new(true);
    let send = |method: &str, uri: &str, body: Option<Value>| {
        let req = h.request(method, uri, None, body);
        h.send(req)
    };
    let (status, list) = send("GET", "/api/cli-paths", None).await;
    assert_eq!(status, StatusCode::OK);
    let providers: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["provider"].as_str().unwrap())
        .collect();
    // The mock agent's file is never chosen, even when it is offered.
    assert_eq!(providers, ["claude", "cursor", "amp"]);
    assert!(list[0]["path"].is_null());

    let cli = h.files.path().join("my-amp");
    write_script(
        &cli,
        "#!/bin/sh\ncase \"$1\" in --version) echo 9.9.9 ;; *) echo 'Signed in as x' ;; esac\n",
    );
    let (status, info) = send(
        "PUT",
        "/api/cli-paths/amp",
        Some(json!({ "path": cli.to_str().unwrap() })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["preflight"]["source"], "chosen");
    assert_eq!(info["preflight"]["binary"], cli.to_str().unwrap());
    assert_eq!(info["preflight"]["version"], "9.9.9");
    let (_, list) = send("GET", "/api/cli-paths", None).await;
    assert_eq!(list[2]["path"], cli.to_str().unwrap());

    // Not an executable, not a full path, the mock agent: 400, and nothing changes.
    let notes = h.files.path().join("notes.txt");
    std::fs::write(&notes, "x").unwrap();
    for (uri, body) in [
        (
            "/api/cli-paths/amp",
            json!({ "path": notes.to_str().unwrap() }),
        ),
        ("/api/cli-paths/amp", json!({ "path": "amp" })),
        (
            "/api/cli-paths/mock",
            json!({ "path": cli.to_str().unwrap() }),
        ),
        ("/api/cli-paths/amp", json!({ "file": "x" })),
        ("/api/cli-paths/nope", json!({ "path": null })),
    ] {
        let (status, body) = send("PUT", uri, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
        assert!(
            body["error"].is_string(),
            "not the API's JSON error: {uri}: {body}"
        );
    }
    let (_, list) = send("GET", "/api/cli-paths", None).await;
    assert_eq!(list[2]["path"], cli.to_str().unwrap());

    let (status, info) = send("PUT", "/api/cli-paths/amp", Some(json!({ "path": null }))).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_ne!(info["preflight"]["source"], "chosen");
    let (_, list) = send("GET", "/api/cli-paths", None).await;
    assert!(list[2]["path"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn two_projects_run_at_once_and_skip_works() {
    let h = Harness::new(true);
    let (a, b) = (Repo::new().await, Repo::new().await);
    let hang = json!({ "whenPrompt": "(dev-1)", "onceFile": h.once_file("dev-1-b"), "steps": [
        { "text": "working" }, { "hang": true }
    ]});
    let in_a = h.create(&a.path, "In A", h.agent(1, vec![]), false).await;
    let in_b = h
        .create(&b.path, "In B", h.agent(2, vec![hang]), false)
        .await;

    h.wait_for(&a.path, &in_a, "A in human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
    h.wait_for(&b.path, &in_b, "B on dev-1", |t| {
        t["run"]["subtaskId"] == "dev-1"
    })
    .await;
    // Each project sees only its own tasks.
    let list = h.ok("GET", "/api/tasks", &a.path, None).await;
    assert_eq!(list["tasks"].as_array().unwrap().len(), 1);

    h.ok("POST", &format!("/api/tasks/{in_b}/pause"), &b.path, None)
        .await;
    let task = h
        .ok(
            "POST",
            &format!("/api/tasks/{in_b}/subtasks/dev-1/skip"),
            &b.path,
            None,
        )
        .await;
    assert_eq!(task["subtasks"][0]["status"], "skipped", "{task}");
    h.ok("POST", &format!("/api/tasks/{in_b}/resume"), &b.path, None)
        .await;
    h.wait_for(&b.path, &in_b, "B in human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_usage_limit_in_one_project_holds_the_cli_in_another() {
    let h = Harness::new(true);
    let (a, b) = (Repo::new().await, Repo::new().await);
    let limit = json!({ "whenPrompt": "(dev-1)", "onceFile": h.once_file("limit"), "steps": [
        { "text": "working" }, { "rateLimit": { "inSecs": 3600 } }
    ]});
    let in_a = h
        .create(&a.path, "In A", h.agent(1, vec![limit]), false)
        .await;
    let limited = h
        .wait_for(&a.path, &in_a, "A rate-limited", |t| {
            t["run"]["state"] == "rate_limited"
        })
        .await;
    assert!(limited["run"]["resetsAt"].as_f64().is_some(), "{limited}");

    // The same CLI in another project waits instead of starting.
    let in_b = h.create(&b.path, "In B", h.agent(1, vec![]), false).await;
    h.wait_for(&b.path, &in_b, "B rate-limited", |t| {
        t["run"]["state"] == "rate_limited" && t["run"]["kind"] == "plan"
    })
    .await;

    // Resume now: the limit is forgotten and B runs to the end.
    h.ok("POST", &format!("/api/tasks/{in_b}/resume"), &b.path, None)
        .await;
    h.wait_for(&b.path, &in_b, "B in human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;
    // Pausing A stops its wait.
    let (status, body) = h
        .call("POST", &format!("/api/tasks/{in_a}/pause"), &a.path, None)
        .await;
    assert!(status.is_success(), "{body}");
    let a_now = h
        .ok("GET", &format!("/api/tasks/{in_a}"), &a.path, None)
        .await;
    assert_eq!(a_now["run"]["state"], "paused", "{a_now}");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_the_server_leaves_running_tasks_interrupted() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let hang =
        json!({ "whenPrompt": "(dev-1)", "steps": [{ "text": "working" }, { "hang": true }] });
    let id = h
        .create(&repo.path, "Cut short", h.agent(1, vec![hang]), false)
        .await;
    h.wait_for(&repo.path, &id, "dev-1 running", |t| {
        t["run"]["subtaskId"] == "dev-1" && t["run"]["pid"].is_number()
    })
    .await;

    h.state.shutdown_engines().await;
    let task = ca_core::TaskStore::new(&ProjectDir::open(&repo.path).await.unwrap())
        .load(&id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.run.unwrap().state, ca_core::RunState::Interrupted);

    let (status, body) = h.call("GET", "/api/tasks", &repo.path, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relative_project_path_is_refused() {
    let h = Harness::new(true);
    let (status, body) = h
        .call("GET", "/api/tasks", Path::new("some/relative/dir"), None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_never_starts_ends_its_log_with_why() {
    let h = Harness::with_bins(
        true,
        Binaries::from_env().with_override(Provider::Claude, "/nonexistent/claude-cli"),
    );
    let repo = Repo::new().await;
    let p = &repo.path;
    let id = h
        .create(p, "No CLI", json!({ "provider": "claude" }), false)
        .await;
    let task = h
        .wait_for(p, &id, "a failed run", |t| run_state(t) == Some("failed"))
        .await;
    assert!(task["run"]["error"].is_string(), "{task}");
    let runs = h.ok("GET", &format!("/api/tasks/{id}/runs"), p, None).await;
    let runs = runs.as_array().unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert!(runs[0]["outcome"].is_null());
    assert!(
        runs[0]["abandoned"].as_str().is_some_and(|r| !r.is_empty()),
        "{runs:?}"
    );
    let name = runs[0]["name"].as_str().unwrap();
    let lines = h
        .ok("GET", &format!("/api/tasks/{id}/runs/{name}"), p, None)
        .await;
    assert_eq!(
        lines.as_array().unwrap().last().unwrap()["line"],
        "abandoned"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_task_keeps_its_worktree_and_can_still_be_deleted() {
    let h = Harness::new(true);
    let repo = Repo::new().await;
    let p = &repo.path;
    let id = h.create(p, "Soon broken", h.agent(1, vec![]), false).await;
    h.wait_for(p, &id, "human review", |t| {
        phase(t) == "human_review" && t["run"].is_null()
    })
    .await;

    let (status, _) = h
        .call("DELETE", "/api/worktrees/no-such-worktree", p, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let file = p
        .join(".code-automata")
        .join("tasks")
        .join(&id)
        .join("task.json");
    std::fs::write(&file, "{ not json").unwrap();
    let list = h.ok("GET", "/api/worktrees", p, None).await;
    let entry = &list.as_array().unwrap()[0];
    assert_eq!(entry["taskId"], json!(id));
    assert_eq!(entry["orphan"], false, "{entry}");
    let (status, body) = h
        .call("DELETE", &format!("/api/worktrees/{id}"), p, None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    let tasks = h.ok("GET", "/api/tasks", p, None).await;
    assert_eq!(tasks["skipped"].as_array().unwrap().len(), 1);
    let (status, body) = h.call("DELETE", &format!("/api/tasks/{id}"), p, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert!(!file.exists());
    let list = h.ok("GET", "/api/worktrees", p, None).await;
    assert_eq!(list, json!([]));
}

/// One request to a running `ca-server` over plain HTTP/1.1.
#[cfg(unix)]
fn raw_http(
    port: u16,
    method: &str,
    path: &str,
    project: &Path,
    body: Option<Value>,
) -> (u16, Value) {
    use std::io::{Read, Write};
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let project = percent_encoding::utf8_percent_encode(
        project.to_str().unwrap(),
        percent_encoding::NON_ALPHANUMERIC,
    );
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\
         X-Project-Path: {project}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let status = response[9..12].parse().unwrap();
    let json = response
        .split_once("\r\n\r\n")
        .and_then(|(_, b)| serde_json::from_str(b).ok())
        .unwrap_or(Value::Null);
    (status, json)
}

/// SIGTERM, as a process manager sends it, stops the server the same way Ctrl-C does: engines
/// shut down, runs are left interrupted and the agent is gone.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn sigterm_stops_the_server_and_leaves_runs_interrupted() {
    use std::io::BufRead;
    let h = Harness::new(true); // only for its scenario helpers
    let repo = Repo::new().await;
    let hang =
        json!({ "whenPrompt": "(dev-1)", "steps": [{ "text": "working" }, { "hang": true }] });
    let agent = h.agent(1, vec![hang]);

    let mut server = std::process::Command::new(env!("CARGO_BIN_EXE_ca-server"))
        .args(["--port", "0", "--token", TOKEN, "--allow-mock"])
        .env("CODE_AUTOMATA_MOCK_AGENT", mock_agent())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // Keep stdout open until the server exits: it prints a second line (the token) after the
    // first, and a closed pipe makes that println panic and kill the server.
    let mut stdout = std::io::BufReader::new(server.stdout.take().unwrap());
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let port: u16 = first.trim().rsplit(':').next().unwrap().parse().unwrap();

    let p = repo.path.clone();
    let (status, task) = raw_http(
        port,
        "POST",
        "/api/tasks",
        &p,
        Some(json!({ "title": "Term", "agents": same(agent) })),
    );
    assert_eq!(status, 201, "{task}");
    let id = task["id"].as_str().unwrap().to_string();
    let mut agent_pid = None;
    for _ in 0..400 {
        let (_, t) = raw_http(port, "GET", &format!("/api/tasks/{id}"), &p, None);
        if t["run"]["subtaskId"] == "dev-1" && t["run"]["pid"].is_number() {
            agent_pid = t["run"]["pid"].as_u64();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let agent_pid = agent_pid.expect("dev-1 never started");

    let status = std::process::Command::new("kill")
        .args(["-TERM", &server.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = tokio::task::spawn_blocking(move || server.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(exit.success(), "{exit:?}");
    drop(stdout);

    let task = ca_core::TaskStore::new(&ProjectDir::open(&p).await.unwrap())
        .load(&id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.run.unwrap().state, ca_core::RunState::Interrupted);
    let alive = std::process::Command::new("kill")
        .args(["-0", &agent_pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(!alive, "the agent outlived the server");
}

/// The UI has no scenario field: a task created as, or edited to, the mock agent plays the
/// server's `--mock-scenario`.
#[tokio::test(flavor = "multi_thread")]
async fn mock_tasks_from_the_ui_get_the_default_scenario() {
    let repo = Repo::new().await;
    let scenario = repo.path.join("default-scenario.json");
    let h = {
        let state = AppState::new(Config {
            token: TOKEN.into(),
            port: PORT,
            allow_mock: true,
            mock_scenario: Some(scenario.clone()),
            bins: Binaries::from_env().with_override(Provider::Mock, mock_agent()),
            allowed_origins: Vec::new(),
            wake_timing: ca_core::engine::limits::WakeTiming::default(),
        });
        Harness {
            app: ca_server::router(state.clone()),
            state,
            files: tempfile::tempdir().unwrap(),
        }
    };
    let p = &repo.path;
    let created = h
        .ok(
            "POST",
            "/api/tasks",
            p,
            Some(json!({ "title": "Mock", "agents": same(json!({ "provider": "mock" })), "start": false })),
        )
        .await;
    assert_eq!(
        created["agents"]["dev"]["options"]["scenario"],
        json!(scenario)
    );

    let other = h
        .ok(
            "POST",
            "/api/tasks",
            p,
            Some(json!({ "title": "Claude", "agents": same(json!({ "provider": "claude" })), "start": false })),
        )
        .await;
    assert!(other["agents"]["dev"]["options"].is_null(), "{other}");
    let id = other["id"].as_str().unwrap();
    let edited = h
        .ok(
            "PATCH",
            &format!("/api/tasks/{id}"),
            p,
            Some(json!({ "agents": same(json!({ "provider": "mock" })) })),
        )
        .await;
    assert_eq!(
        edited["agents"]["qa"]["options"]["scenario"],
        json!(scenario)
    );
}
