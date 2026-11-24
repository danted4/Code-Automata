#![allow(clippy::unwrap_used)]

mod common;

use ca_core::git::{
    DeleteOptions, Worktrees, checkpoint_commit, diff_since_checkpoint, head, squash_checkpoints,
};
use ca_core::{CoreError, ProjectDir};
use common::{TempRepo, git};

#[tokio::test]
async fn project_dir_rejects_bad_paths() {
    let relative = ProjectDir::open("some/relative/path").await;
    assert!(matches!(relative, Err(CoreError::InvalidProject { .. })));

    let missing = ProjectDir::open("/definitely/not/here/code-automata").await;
    assert!(matches!(missing, Err(CoreError::InvalidProject { .. })));

    let plain = tempfile::tempdir().unwrap();
    let not_git = ProjectDir::open(plain.path()).await;
    assert!(
        matches!(&not_git, Err(CoreError::InvalidProject { reason, .. }) if reason.contains("git")),
        "{not_git:?}"
    );

    let file = plain.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert!(matches!(
        ProjectDir::open(&file).await,
        Err(CoreError::InvalidProject { .. })
    ));
}

#[tokio::test]
async fn project_dir_in_a_subfolder_keeps_tasks_there_and_worktrees_at_the_repo_root() {
    let repo = TempRepo::new();
    let sub = repo.path.join("packages").join("app");
    std::fs::create_dir_all(&sub).unwrap();
    let project = ProjectDir::open(&sub).await.unwrap();
    assert_eq!(project.root(), sub);
    assert_eq!(project.repo_root(), repo.path);
    assert!(project.tasks_dir().starts_with(&sub));
    assert!(project.worktrees_dir().starts_with(&repo.path));
}

#[tokio::test]
async fn worktree_lifecycle_with_checkpoints_and_squash() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let wts = Worktrees::new(project.clone());
    let id = "task-1-abc";

    assert_eq!(wts.main_branch().await, "main");

    let info = wts.create(id).await.unwrap();
    assert_eq!(info.branch_name, "code-automata/task-1-abc");
    assert!(info.path.ends_with(".code-automata/worktrees/task-1-abc"));
    let base = info.base_commit.clone().unwrap();
    assert_eq!(base, git(&repo.path, &["rev-parse", "HEAD"]));
    assert!(wts.create(id).await.is_err(), "creating twice must fail");

    let wt = info.path.clone();
    let status = wts.status(id).await.unwrap();
    assert!(status.exists);
    assert_eq!(status.has_changes, Some(false));
    assert_eq!(
        status.branch_name.as_deref(),
        Some("code-automata/task-1-abc")
    );

    // Subtask 1 finishes: one checkpoint.
    std::fs::write(wt.join("a.txt"), "alpha\n").unwrap();
    assert_eq!(wts.status(id).await.unwrap().has_changes, Some(true));
    let cp1 = checkpoint_commit(&wt, id, "subtask-1", "Create a")
        .await
        .unwrap();
    assert!(cp1.created);
    let msg = git(&wt, &["log", "-1", "--format=%B"]);
    assert!(msg.contains("Code-Automata-Subtask: subtask-1"), "{msg}");

    // A subtask that changed nothing does not create an empty commit.
    let same = checkpoint_commit(&wt, id, "subtask-1b", "No-op")
        .await
        .unwrap();
    assert!(!same.created);
    assert_eq!(same.commit, cp1.commit);

    // Subtask 2 finishes: second checkpoint.
    std::fs::write(wt.join("b.txt"), "beta\n").unwrap();
    let cp2 = checkpoint_commit(&wt, id, "subtask-2", "Create b")
        .await
        .unwrap();
    assert!(cp2.created);
    assert_ne!(cp1.commit, cp2.commit);

    // Subtask 3 is interrupted part-way: the diff shows only its own work.
    std::fs::write(wt.join("a.txt"), "alpha\nmore\n").unwrap();
    std::fs::write(wt.join("c.txt"), "gamma\n").unwrap();
    let diff = diff_since_checkpoint(&wt, 1 << 20).await.unwrap();
    assert_eq!(diff.base, cp2.commit);
    assert!(diff.diff.contains("+more"), "{}", diff.diff);
    assert!(
        !diff.diff.contains("beta"),
        "earlier checkpoint leaked into the diff"
    );
    assert_eq!(diff.untracked, ["c.txt"]);
    assert!(!diff.truncated);
    // Reading the diff must not stage anything.
    assert!(git(&wt, &["diff", "--cached", "--name-only"]).is_empty());

    let small = diff_since_checkpoint(&wt, 10).await.unwrap();
    assert!(small.truncated);
    assert!(small.diff.len() <= 10);

    // PR time: everything since the base becomes one commit.
    let squashed = squash_checkpoints(&wt, &base, "Add a, b and c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        git(&wt, &["rev-list", "--count", &format!("{base}..HEAD")]),
        "1"
    );
    assert_eq!(head(&wt).await.unwrap(), squashed);
    let files = git(&wt, &["show", "--name-only", "--format=", "HEAD"]);
    for f in ["a.txt", "b.txt", "c.txt"] {
        assert!(files.contains(f), "{f} missing from squash: {files}");
    }
    assert!(git(&wt, &["status", "--porcelain"]).is_empty());

    // Squashing again with nothing new leaves the branch alone.
    assert_eq!(
        squash_checkpoints(&wt, &squashed, "again").await.unwrap(),
        None
    );
    assert_eq!(head(&wt).await.unwrap(), squashed);

    let listed = wts.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].task_id, id);
    assert_eq!(listed[0].is_dirty, Some(false));

    let usage = wts.disk_usage().await.unwrap();
    assert!(usage.per_worktree[id] > 0);
    assert_eq!(usage.total_bytes, usage.per_worktree[id]);

    let report = wts
        .delete(
            id,
            DeleteOptions {
                delete_branch: true,
                ..DeleteOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(!wt.exists());
    assert!(git(&repo.path, &["branch", "--list", "code-automata/*"]).is_empty());
    assert!(wts.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn squash_refuses_a_base_that_is_not_an_ancestor() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-2").await.unwrap();
    // A commit on main after the branch was cut is not an ancestor of the task branch.
    std::fs::write(repo.path.join("other.txt"), "x").unwrap();
    git(&repo.path, &["add", "-A"]);
    git(&repo.path, &["commit", "-q", "-m", "other"]);
    let foreign = git(&repo.path, &["rev-parse", "HEAD"]);

    std::fs::write(info.path.join("a.txt"), "a").unwrap();
    checkpoint_commit(&info.path, "task-2", "s1", "a")
        .await
        .unwrap();
    let before = head(&info.path).await.unwrap();
    assert!(squash_checkpoints(&info.path, &foreign, "m").await.is_err());
    assert_eq!(head(&info.path).await.unwrap(), before, "branch moved");
}

#[tokio::test]
async fn dirty_worktree_needs_force_to_delete() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-3").await.unwrap();
    std::fs::write(info.path.join("wip.txt"), "wip").unwrap();

    assert!(
        wts.delete("task-3", DeleteOptions::default())
            .await
            .is_err()
    );
    assert!(info.path.exists());

    wts.delete(
        "task-3",
        DeleteOptions {
            force: true,
            ..DeleteOptions::default()
        },
    )
    .await
    .unwrap();
    assert!(!info.path.exists());
}

#[tokio::test]
async fn a_stray_folder_is_not_reported_as_the_main_checkout() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    // Make the main checkout dirty, then create a plain folder where a worktree would be.
    std::fs::write(repo.path.join("README.md"), "changed").unwrap();
    std::fs::create_dir_all(wts.path_for("task-stray").unwrap()).unwrap();

    let status = wts.status("task-stray").await.unwrap();
    assert!(status.exists);
    assert!(status.error.is_some(), "{status:?}");
    assert_eq!(
        status.has_changes, None,
        "reported the main checkout's changes"
    );
}

#[tokio::test]
async fn delete_refuses_paths_outside_the_worktrees_folder() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let victim = repo.path.join("important");
    std::fs::create_dir_all(&victim).unwrap();
    std::fs::write(victim.join("keep.txt"), "keep").unwrap();

    for path in [
        victim.clone(),
        wts.base_path(),
        wts.base_path().join("..").join("..").join("important"),
    ] {
        let result = wts
            .delete(
                "task-x",
                DeleteOptions {
                    force: true,
                    path_override: Some(path.clone()),
                    ..DeleteOptions::default()
                },
            )
            .await;
        assert!(result.is_err(), "deleted {}", path.display());
    }
    assert!(victim.join("keep.txt").exists());
}
