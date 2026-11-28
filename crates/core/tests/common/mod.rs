//! Shared test helpers: throwaway git repositories and fixture loading.
#![allow(dead_code, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::process::Command;

use ca_core::{ProjectDir, TaskStore};
use serde_json::Value;
use tempfile::TempDir;

/// A temporary git repository with one commit and a local identity. Dropping it deletes it.
pub struct TempRepo {
    _dir: TempDir,
    pub path: PathBuf,
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

impl TempRepo {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // The same plain form (no `\\?\` on Windows) the project code uses.
        let path = ca_core::util::plain_path(std::fs::canonicalize(dir.path()).unwrap());
        init_repo(&path);
        TempRepo { _dir: dir, path }
    }

    pub async fn project(&self) -> ProjectDir {
        ProjectDir::open(&self.path).await.unwrap()
    }
}

/// A temporary workspace: a plain folder holding one repository per name (each like
/// [`TempRepo`]). Dropping it deletes it.
pub struct TempWorkspace {
    _dir: TempDir,
    pub path: PathBuf,
}

impl TempWorkspace {
    pub fn new(repos: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = ca_core::util::plain_path(std::fs::canonicalize(dir.path()).unwrap());
        for name in repos {
            let repo = path.join(name);
            std::fs::create_dir_all(&repo).unwrap();
            init_repo(&repo);
        }
        TempWorkspace { _dir: dir, path }
    }

    pub fn repo(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub async fn project(&self) -> ProjectDir {
        ProjectDir::open(&self.path).await.unwrap()
    }
}

/// `git init` with one commit on `main` and a local identity.
pub fn init_repo(path: &Path) {
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.name", "Test"]);
    git(path, &["config", "user.email", "test@example.com"]);
    git(path, &["config", "commit.gpgsign", "false"]);
    std::fs::write(path.join("README.md"), "# test\n").unwrap();
    git(path, &["add", "-A"]);
    git(path, &["commit", "-q", "-m", "init"]);
}

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

pub fn fixture_json(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_path(name)).unwrap()).unwrap()
}

pub fn task_file(project: &ProjectDir, id: &str) -> PathBuf {
    project.tasks_dir().join(id).join("task.json")
}

/// Write raw JSON as a task file under `id`.
pub fn write_task_json(project: &ProjectDir, id: &str, json: &Value) {
    let path = task_file(project, id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(json).unwrap()).unwrap();
}

pub fn read_task_json(project: &ProjectDir, id: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(task_file(project, id)).unwrap()).unwrap()
}

/// A temp repo with its store, and the example task installed. Returns the example's id.
pub async fn store_with_example() -> (TempRepo, ProjectDir, TaskStore, String) {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let json = fixture_json("task-example.json");
    let id = json["id"].as_str().unwrap().to_string();
    write_task_json(&project, &id, &json);
    let store = TaskStore::new(&project);
    (repo, project, store, id)
}

/// Whether a process with this pid exists.
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(windows)]
    {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
    }
}

/// Write an executable script (a fake CLI, a git hook) that the test then runs.
///
/// Not `std::fs::write`: while this process holds the file open for writing, a child that another
/// test thread forks inherits that descriptor until it execs, and running the script in that window
/// fails with ETXTBSY ("text file busy", Linux). A child `sh` writes the file instead, so this
/// process never holds it open, and nothing does once the call returns.
#[cfg(unix)]
pub fn write_script(path: &Path, contents: &str) {
    use std::io::Write;
    let mut child = Command::new("sh")
        .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
        .arg(path)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(contents.as_bytes())
        .unwrap();
    assert!(
        child.wait().unwrap().success(),
        "writing {}",
        path.display()
    );
}
