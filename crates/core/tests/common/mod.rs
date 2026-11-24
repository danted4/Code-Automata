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
        let path = std::fs::canonicalize(dir.path()).unwrap();
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "Test"]);
        git(&path, &["config", "user.email", "test@example.com"]);
        git(&path, &["config", "commit.gpgsign", "false"]);
        std::fs::write(path.join("README.md"), "# test\n").unwrap();
        std::fs::write(path.join(".gitignore"), ".code-automata/\n").unwrap();
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-q", "-m", "init"]);
        TempRepo { _dir: dir, path }
    }

    pub async fn project(&self) -> ProjectDir {
        ProjectDir::open(&self.path).await.unwrap()
    }
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

/// Copy a fixture into the project's tasks directory under its own id. Returns the task id.
pub fn install_fixture(project: &ProjectDir, name: &str) -> String {
    let json = fixture_json(name);
    let id = json["id"].as_str().unwrap().to_string();
    std::fs::create_dir_all(project.tasks_dir()).unwrap();
    std::fs::copy(
        fixture_path(name),
        project.tasks_dir().join(format!("{id}.json")),
    )
    .unwrap();
    id
}

pub fn read_task_json(project: &ProjectDir, id: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(project.tasks_dir().join(format!("{id}.json"))).unwrap(),
    )
    .unwrap()
}

pub async fn store_with(fixtures: &[&str]) -> (TempRepo, ProjectDir, TaskStore, Vec<String>) {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let ids = fixtures
        .iter()
        .map(|f| install_fixture(&project, f))
        .collect();
    let store = TaskStore::new(&project);
    (repo, project, store, ids)
}
