//! Workspaces: a plain folder of repositories opened as one project, and the per-repository
//! worktree layout of its tasks.
#![allow(clippy::unwrap_used)]

mod common;

use ca_core::git::{self, DeleteOptions, Worktrees};
use ca_core::project::ProjectKind;
use ca_core::{CoreError, ProjectDir};
use common::{TempRepo, TempWorkspace, git, init_repo};

fn refusal(result: ca_core::Result<ProjectDir>) -> String {
    match result {
        Err(CoreError::InvalidProject { reason, .. }) => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_folder_of_repositories_opens_as_a_workspace() {
    let ws = TempWorkspace::new(&["web", "api"]);
    // Hidden folders and loose files are ignored.
    std::fs::create_dir_all(ws.path.join(".vscode")).unwrap();
    std::fs::write(ws.path.join("README.md"), "notes\n").unwrap();
    let project = ws.project().await;
    assert_eq!(project.kind(), ProjectKind::Workspace);
    assert_eq!(project.root(), ws.path);
    let names: Vec<_> = project.repos().iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["api", "web"], "sorted by name");
    assert_eq!(project.repos()[0].path, ws.repo("api"));
    assert!(project.repo_path(".").is_err());
    assert_eq!(project.repo_path("api").unwrap(), ws.repo("api"));
    assert!(project.repo_path("../api").is_err());
    // Nothing to exclude: the workspace folder is in no repository.
    project.ensure_git_exclude().await.unwrap();
}

#[tokio::test]
async fn a_repository_project_has_one_repository() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    assert_eq!(project.kind(), ProjectKind::Repo);
    assert_eq!(project.repos().len(), 1);
    assert_eq!(project.repos()[0].name, ".");
    assert_eq!(project.repo_path(".").unwrap(), repo.path);
    assert!(project.repo_path("api").is_err());
}

#[tokio::test]
async fn a_folder_that_is_not_a_repository_is_refused_and_named() {
    let ws = TempWorkspace::new(&["api"]);
    std::fs::create_dir_all(ws.path.join("notes")).unwrap();
    std::fs::create_dir_all(ws.path.join("scripts")).unwrap();
    let reason = refusal(ProjectDir::open(&ws.path).await);
    assert!(
        reason.contains("Not repositories: notes, scripts"),
        "{reason}"
    );
    assert!(reason.contains("safe on disk"), "{reason}");
}

#[tokio::test]
async fn a_folder_with_no_repositories_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let reason = refusal(ProjectDir::open(dir.path()).await);
    assert!(reason.contains("holds no git repositories"), "{reason}");
}

#[tokio::test]
async fn a_repository_nested_in_a_folder_of_a_repository_is_not_a_workspace_repository() {
    // `outer` is a repository; `outer/libs` is a plain folder in it holding a nested clone.
    let outer = TempRepo::new();
    let libs = outer.path.join("libs");
    std::fs::create_dir_all(libs.join("nested")).unwrap();
    init_repo(&libs.join("nested"));
    let reason = refusal(ProjectDir::open(&libs).await);
    assert!(reason.contains("open the repository root"), "{reason}");
}

#[tokio::test]
async fn task_worktrees_cannot_be_opened_as_projects() {
    let ws = TempWorkspace::new(&["api", "web"]);
    let project = ws.project().await;
    let api = Worktrees::for_repo(&project, "api").unwrap();
    Worktrees::for_repo(&project, "web")
        .unwrap()
        .create("task-1")
        .await
        .unwrap();
    let info = api.create("task-1").await.unwrap();
    let task_dir = git::task_dir(&project, "task-1").unwrap();
    // The task folder holds only repositories, so it would otherwise look like a workspace.
    assert!(refusal(ProjectDir::open(&task_dir).await).contains("task worktrees"));
    assert!(refusal(ProjectDir::open(&info.path).await).contains("task worktrees"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_repository_counts() {
    let ws = TempWorkspace::new(&["api"]);
    let elsewhere = TempRepo::new();
    std::os::unix::fs::symlink(&elsewhere.path, ws.path.join("web")).unwrap();
    let project = ws.project().await;
    let names: Vec<_> = project.repos().iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["api", "web"]);
}

#[tokio::test]
async fn a_linked_worktree_counts_as_a_repository() {
    // `web` is a worktree of a repository elsewhere: its `.git` is a file.
    let ws = TempWorkspace::new(&["api"]);
    let main = TempRepo::new();
    let web = ws.path.join("web");
    git(
        &main.path,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "side",
            &web.to_string_lossy(),
        ],
    );
    assert!(web.join(".git").is_file());
    let project = ws.project().await;
    assert_eq!(project.repos().len(), 2);
}

#[tokio::test]
async fn each_repository_gets_its_worktree_inside_the_task_folder() {
    let ws = TempWorkspace::new(&["api", "web"]);
    let project = ws.project().await;
    let id = "task-1-abc";
    let task_dir = git::task_dir(&project, id).unwrap();
    for name in ["api", "web"] {
        let w = Worktrees::for_repo(&project, name).unwrap();
        let info = w.create(id).await.unwrap();
        assert_eq!(info.path, task_dir.join(name));
        assert_eq!(info.repo, name);
        assert_eq!(info.main_repo, ws.repo(name));
        assert_eq!(
            git(&info.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "code-automata/task-1-abc"
        );
        let listed = w.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].task_id, id);
        assert_eq!(listed[0].repo, name);
    }
    let names = vec!["api".to_string(), "web".to_string()];
    let status = git::task_status(&project, id, &names).await.unwrap();
    assert!(status.exists);
    assert_eq!(status.has_changes, Some(false));

    std::fs::write(task_dir.join("web").join("x.txt"), "x").unwrap();
    let status = git::task_status(&project, id, &names).await.unwrap();
    assert_eq!(status.has_changes, Some(true));

    // A leftover at the top of the task folder goes with it.
    std::fs::write(task_dir.join("stray.txt"), "x").unwrap();
    let opts = DeleteOptions {
        force: true,
        delete_branch: true,
        ..DeleteOptions::default()
    };
    git::delete_task_worktrees(&project, id, &names, opts)
        .await
        .unwrap();
    assert!(!task_dir.exists());
    for name in ["api", "web"] {
        let branches = git(&ws.repo(name), &["branch", "--list", "code-automata/*"]);
        assert!(branches.is_empty(), "{name}: {branches}");
    }
}

#[tokio::test]
async fn a_task_folder_is_never_removed_as_a_leftover_worktree() {
    let ws = TempWorkspace::new(&["api"]);
    let project = ws.project().await;
    Worktrees::for_repo(&project, "api")
        .unwrap()
        .create("task-1")
        .await
        .unwrap();
    let task_dir = git::task_dir(&project, "task-1").unwrap();
    std::fs::write(task_dir.join("api").join("work.txt"), "uncommitted").unwrap();
    // Treating the task folder as a one-repository worktree must refuse, not delete it.
    let as_root = Worktrees::new(project.clone());
    let opts = DeleteOptions {
        force: true,
        ..DeleteOptions::default()
    };
    assert!(as_root.delete("task-1", opts).await.is_err());
    assert!(task_dir.join("api").join("work.txt").exists());
    assert!(as_root.restore("task-1").await.is_err());
    assert!(task_dir.join("api").join("work.txt").exists());
}

#[tokio::test]
async fn git_never_reaches_an_enclosing_repository_from_a_task_folder() {
    // A task folder inside some repository: git run there must not find that repository.
    let outer = TempRepo::new();
    let task_dir = outer
        .path
        .join(".code-automata")
        .join("worktrees")
        .join("task-1");
    std::fs::create_dir_all(&task_dir).unwrap();
    std::fs::write(outer.path.join("README.md"), "user edit\n").unwrap();
    assert!(git::discard_changes(&task_dir).await.is_err());
    assert_eq!(
        std::fs::read_to_string(outer.path.join("README.md")).unwrap(),
        "user edit\n",
        "the enclosing repository was reset"
    );
}

#[tokio::test]
async fn a_failed_restore_names_the_repository_in_a_workspace() {
    let ws = TempWorkspace::new(&["api", "web"]);
    let project = ws.project().await;
    // No branch was ever made: nothing to restore from.
    let err = git::restore_task_worktrees(&project, "task-9", &["api".into()])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("branch"), "{err}");
}
