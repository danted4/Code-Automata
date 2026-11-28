//! Child processes get the PATH set with `proc::set_child_path` (the login shell's, in the app),
//! so a git hook run by `git push` finds the user's tools even when the app was started from the
//! Dock with the system's minimal PATH. Its own test binary: the PATH is process-wide.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

mod common;

use std::process::Stdio;

#[tokio::test]
async fn git_hooks_run_with_the_child_path() {
    // A tool only on the child PATH, like yarn under nvm.
    let tools = tempfile::tempdir().unwrap();
    let tool = tools.path().join("only-in-login-shell");
    common::write_script(&tool, "#!/bin/sh\necho hook-found-tool\n");
    let system = std::env::var_os("PATH").unwrap();
    let mut path = std::ffi::OsString::from(tools.path());
    path.push(":");
    path.push(&system);
    ca_core::proc::set_child_path(path);

    // A hook that needs that tool: git hands its PATH to hooks, as for the pre-push hook.
    let repo = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let mut cmd = ca_core::proc::command("git");
        cmd.args(args)
            .current_dir(repo.path())
            .stdin(Stdio::null())
            .output()
    };
    assert!(
        git(&["init", "-q", "-b", "main"])
            .await
            .unwrap()
            .status
            .success()
    );
    let hook = repo.path().join(".git/hooks/pre-commit");
    common::write_script(&hook, "#!/bin/sh\nonly-in-login-shell >&2\n");
    std::fs::write(repo.path().join("a.txt"), "a").unwrap();
    assert!(git(&["add", "-A"]).await.unwrap().status.success());
    let out = git(&[
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "x",
    ])
    .await
    .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("hook-found-tool"));
}
