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
async fn a_subfolder_of_a_repository_is_refused() {
    let repo = TempRepo::new();
    let sub = repo.path.join("packages").join("app");
    std::fs::create_dir_all(&sub).unwrap();
    let err = ProjectDir::open(&sub).await.unwrap_err();
    assert!(
        matches!(&err, CoreError::InvalidProject { reason, .. } if reason.contains("open the repository root")),
        "{err:?}"
    );
    let project = ProjectDir::open(&repo.path).await.unwrap();
    assert_eq!(project.root(), repo.path);
    assert!(project.tasks_dir().starts_with(&repo.path));
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
    assert_eq!(
        info.branch_name.as_deref(),
        Some("code-automata/task-1-abc")
    );
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
    assert_eq!(
        listed[0].branch_name.as_deref(),
        Some("code-automata/task-1-abc"),
        "branch is read from git, not invented"
    );

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

#[tokio::test]
async fn non_forced_delete_returns_gits_error_instead_of_wiping() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-5").await.unwrap();
    std::fs::write(info.path.join("committed.txt"), "x").unwrap();
    checkpoint_commit(&info.path, "task-5", "s1", "x")
        .await
        .unwrap();
    // A locked worktree is clean, but `git worktree remove` refuses it.
    git(
        &repo.path,
        &["worktree", "lock", info.path.to_str().unwrap()],
    );

    let err = wts.delete("task-5", DeleteOptions::default()).await;
    assert!(err.is_err(), "a locked worktree was deleted without force");
    assert!(
        info.path.join("committed.txt").exists(),
        "files were removed"
    );
}

#[tokio::test]
async fn deleting_a_vanished_worktree_still_prunes_and_deletes_the_branch() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-6").await.unwrap();
    std::fs::remove_dir_all(&info.path).unwrap();

    let report = wts
        .delete(
            "task-6",
            DeleteOptions {
                delete_branch: true,
                ..DeleteOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(git(&repo.path, &["branch", "--list", "code-automata/task-6"]).is_empty());
    assert!(!git(&repo.path, &["worktree", "list"]).contains("task-6"));
    // The same id can be used again.
    wts.create("task-6").await.unwrap();
}

#[tokio::test]
async fn create_refuses_an_existing_branch() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    git(&repo.path, &["branch", "code-automata/task-7"]);
    let err = wts.create("task-7").await.unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err}");
}

#[tokio::test]
async fn squash_of_work_that_nets_to_nothing_returns_the_branch_to_base() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-8").await.unwrap();
    let base = info.base_commit.unwrap();
    let wt = info.path;

    std::fs::write(wt.join("tmp.txt"), "t").unwrap();
    checkpoint_commit(&wt, "task-8", "s1", "add").await.unwrap();
    std::fs::remove_file(wt.join("tmp.txt")).unwrap();
    checkpoint_commit(&wt, "task-8", "s2", "remove")
        .await
        .unwrap();
    assert_ne!(head(&wt).await.unwrap(), base);

    assert_eq!(squash_checkpoints(&wt, &base, "m").await.unwrap(), None);
    assert_eq!(
        head(&wt).await.unwrap(),
        base,
        "checkpoint commits would ship"
    );
    assert!(git(&wt, &["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn list_only_reports_worktrees_directly_in_the_worktrees_folder() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    wts.create("task-9").await.unwrap();
    // Contains the marker substring but is not ours.
    let nested = repo
        .path
        .join("nested")
        .join(".code-automata")
        .join("worktrees")
        .join("task-other");
    git(
        &repo.path,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "other",
            nested.to_str().unwrap(),
        ],
    );

    let listed = wts.list().await.unwrap();
    let ids: Vec<_> = listed.iter().map(|w| w.task_id.as_str()).collect();
    assert_eq!(ids, ["task-9"]);
}

#[tokio::test]
async fn diff_keeps_whitespace_and_unusual_file_names() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let wt = wts.create("task-10").await.unwrap().path;
    std::fs::write(wt.join("README.md"), "# test\nline   \n\n").unwrap();
    std::fs::write(wt.join("café notes.txt"), "x").unwrap();

    let diff = diff_since_checkpoint(&wt, 1 << 20).await.unwrap();
    assert!(
        diff.diff.ends_with('\n'),
        "diff was trimmed: {:?}",
        diff.diff
    );
    assert!(diff.diff.contains("+line   \n"));
    assert_eq!(diff.untracked, ["café notes.txt"]);
}

#[tokio::test]
async fn forced_delete_of_a_locked_worktree_finishes() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-11").await.unwrap();
    std::fs::write(info.path.join("wip.txt"), "wip").unwrap();
    git(
        &repo.path,
        &["worktree", "lock", info.path.to_str().unwrap()],
    );

    let report = wts
        .delete(
            "task-11",
            DeleteOptions {
                force: true,
                delete_branch: true,
                ..DeleteOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(!info.path.exists());
    assert!(!git(&repo.path, &["worktree", "list"]).contains("task-11"));
    assert!(git(&repo.path, &["branch", "--list", "code-automata/task-11"]).is_empty());
    wts.create("task-11").await.unwrap();
}

#[tokio::test]
async fn a_broken_worktree_is_not_deleted_without_force() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-12").await.unwrap();
    std::fs::write(info.path.join("wip.txt"), "uncommitted").unwrap();
    // Break the worktree's link to the repository, as a pruned admin dir or a moved repo would.
    std::fs::write(
        info.path.join(".git"),
        "gitdir: /nonexistent/worktrees/task-12\n",
    )
    .unwrap();

    let status = wts.status("task-12").await.unwrap();
    assert!(status.error.is_some(), "{status:?}");
    assert!(
        wts.delete("task-12", DeleteOptions::default())
            .await
            .is_err()
    );
    assert!(
        info.path.join("wip.txt").exists(),
        "uncommitted work was wiped"
    );

    wts.delete(
        "task-12",
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
async fn squash_accepts_a_tag_as_base() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-13").await.unwrap();
    git(&info.path, &["tag", "-a", "start", "-m", "start"]);
    std::fs::write(info.path.join("a.txt"), "a").unwrap();
    checkpoint_commit(&info.path, "task-13", "s1", "a")
        .await
        .unwrap();
    let squashed = squash_checkpoints(&info.path, "start", "m")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        git(&info.path, &["rev-parse", &format!("{squashed}^")]),
        info.base_commit.unwrap()
    );
}

#[tokio::test]
async fn code_automata_state_is_excluded_from_git_status() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let wts = Worktrees::new(project.clone());
    let store = ca_core::TaskStore::new(&project);
    store
        .create(ca_core::Task::new(
            "t",
            "",
            ca_core::AgentConfig::new(ca_core::Provider::Mock),
        ))
        .await
        .unwrap();
    wts.create("task-14").await.unwrap();

    assert!(
        git(&repo.path, &["status", "--porcelain"]).is_empty(),
        "main checkout shows .code-automata as untracked"
    );
    assert!(
        !std::fs::read_to_string(repo.path.join(".gitignore"))
            .is_ok_and(|t| t.contains("code-automata"))
    );

    // Idempotent: the line is added once.
    project.ensure_git_exclude().await.unwrap();
    let exclude = std::fs::read_to_string(repo.path.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches("/.code-automata/").count(), 1, "{exclude}");
}

#[tokio::test]
async fn the_exclude_file_is_appended_to_not_rewritten() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let exclude = repo.path.join(".git/info/exclude");
    // Existing user entries: not UTF-8, no trailing newline.
    let mut existing = b"*.log\n# caf\xe9\nbuild".to_vec();
    std::fs::write(&exclude, &existing).unwrap();

    project.ensure_git_exclude().await.unwrap();
    let after = std::fs::read(&exclude).unwrap();
    assert!(
        after.starts_with(&existing),
        "existing entries were changed"
    );
    existing.extend_from_slice(b"\n");
    assert_eq!(
        &after[existing.len()..],
        b"# Code-Automata task state and worktrees\n/.code-automata/\n"
    );
}

#[tokio::test]
async fn concurrent_first_writes_add_the_exclude_line_once() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let mut handles = Vec::new();
    for _ in 0..10 {
        let p = project.clone();
        handles.push(tokio::spawn(async move {
            p.ensure_git_exclude().await.unwrap()
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    let text = std::fs::read_to_string(repo.path.join(".git/info/exclude")).unwrap();
    assert_eq!(text.matches("/.code-automata/").count(), 1, "{text}");
}

#[tokio::test]
async fn a_task_worktree_cannot_be_opened_as_a_project() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-15").await.unwrap();
    let err = ProjectDir::open(info.path.join(".")).await.unwrap_err();
    assert!(err.to_string().contains("task worktree"), "{err}");
}

/// Another git process (an editor polling `git status`, say) can hold the index lock for a
/// moment. A write the engine runs meanwhile waits for it instead of failing the task.
#[tokio::test]
async fn a_write_waits_out_a_briefly_held_index_lock() {
    let repo = TempRepo::new();
    std::fs::write(repo.path.join("README.md"), "changed\n").unwrap();
    let lock = repo.path.join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();
    let release = {
        let lock = lock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            std::fs::remove_file(lock).unwrap();
        })
    };
    ca_core::git::discard_changes(&repo.path).await.unwrap();
    release.await.unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
        "# test\n"
    );
}

/// A lock left by a git process that died is not waited on: the error comes at once and names
/// the file to remove. Unix only: on Windows a lock no process holds open is removed instead
/// (`a_dead_index_lock_does_not_block_the_next_checkpoint`).
#[cfg(not(windows))]
#[tokio::test]
async fn a_stale_index_lock_fails_at_once_with_its_path() {
    let repo = TempRepo::new();
    std::fs::write(repo.path.join("README.md"), "changed\n").unwrap();
    let lock = repo.path.join(".git").join("index.lock");
    let file = std::fs::File::create(&lock).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(120))
        .unwrap();
    drop(file);
    let started = std::time::Instant::now();
    let err = ca_core::git::discard_changes(&repo.path).await.unwrap_err();
    assert!(
        started.elapsed() < std::time::Duration::from_millis(500),
        "waited {:?} on a stale lock",
        started.elapsed()
    );
    assert!(err.to_string().contains("index.lock"), "{err}");
}

/// On Windows a run's leftover `git`, killed with its Job Object, leaves `index.lock` behind for
/// good. A lock no process holds open is removed, and the command (here a reset) goes on.
#[cfg(windows)]
#[tokio::test]
async fn a_dead_runs_index_lock_does_not_block_the_discard() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-lock").await.unwrap();
    let base = info.base_commit.clone().unwrap();
    std::fs::write(info.path.join("leftover.txt"), "x").unwrap();
    let lock = git(&info.path, &["rev-parse", "--git-path", "index.lock"]);
    let lock = std::path::PathBuf::from(lock);
    let lock = if lock.is_absolute() {
        lock
    } else {
        info.path.join(lock)
    };
    std::fs::write(&lock, "").unwrap();

    ca_core::git::discard_to(&info.path, &base).await.unwrap();
    assert!(!lock.exists());
    assert!(!info.path.join("leftover.txt").exists());
}

/// The same dead lock, long past the 15 s after which a lock is no longer waited on, must not fail
/// the next checkpoint (`git add -A`) either.
#[cfg(windows)]
#[tokio::test]
async fn a_dead_index_lock_does_not_block_the_next_checkpoint() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-lock2").await.unwrap();
    std::fs::write(info.path.join("work.txt"), "x").unwrap();
    let lock =
        std::path::PathBuf::from(git(&info.path, &["rev-parse", "--git-path", "index.lock"]));
    let lock = if lock.is_absolute() {
        lock
    } else {
        info.path.join(lock)
    };
    let file = std::fs::File::create(&lock).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
        .unwrap();
    drop(file);

    let cp = checkpoint_commit(&info.path, "task-lock2", "dev-1", "Work")
        .await
        .unwrap();
    assert!(cp.created, "the checkpoint was committed");
    assert!(!lock.exists());
}

/// A lock a live process holds open is never removed: git for Windows opens it without delete
/// sharing, and this test opens it the same way.
#[cfg(windows)]
#[tokio::test]
async fn a_held_index_lock_is_not_removed() {
    let repo = TempRepo::new();
    let wts = Worktrees::new(repo.project().await);
    let info = wts.create("task-lock3").await.unwrap();
    let base = info.base_commit.clone().unwrap();
    let lock =
        std::path::PathBuf::from(git(&info.path, &["rev-parse", "--git-path", "index.lock"]));
    let lock = if lock.is_absolute() {
        lock
    } else {
        info.path.join(lock)
    };
    // Opened as git opens it: read and write sharing only, no FILE_SHARE_DELETE (std's default
    // includes it).
    let held = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&lock)
            .unwrap()
    };
    held.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
        .unwrap();
    assert!(ca_core::git::discard_to(&info.path, &base).await.is_err());
    assert!(lock.exists(), "a held lock stays");
    drop(held);
}
