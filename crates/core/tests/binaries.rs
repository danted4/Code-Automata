//! Finding the agent CLIs: the file the user chose, then the provider's install folder, then the
//! PATH; and choosing a file. The fake CLIs are shell scripts.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use ca_core::Provider;
use ca_core::agent::Binaries;
use ca_core::agent::env::{BinarySource, ChosenPaths};
use ca_core::agent::preflight::check;

fn script(path: &Path, body: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_path_buf()
}

#[test]
fn the_native_install_wins_over_an_older_copy_on_path() {
    // `claude install` after an npm install under nvm: the npm copy is still on PATH.
    let home = tempfile::tempdir().unwrap();
    let nvm = tempfile::tempdir().unwrap();
    let native = script(&home.path().join(".local/bin/claude"), "echo native");
    script(&nvm.path().join("claude"), "echo npm");

    let bins = Binaries::from_search_path(nvm.path().into()).with_home(home.path());
    assert_eq!(
        bins.find(Provider::Claude).unwrap(),
        (native, BinarySource::InstallFolder)
    );
    // Without a home (tests, `from_env`), only the PATH is searched.
    let path_only = Binaries::from_search_path(nvm.path().into());
    assert_eq!(
        path_only.find(Provider::Claude).unwrap(),
        (nvm.path().join("claude"), BinarySource::Path)
    );
}

#[test]
fn the_older_local_install_reached_by_an_alias_is_found() {
    let home = tempfile::tempdir().unwrap();
    let local = script(&home.path().join(".claude/local/claude"), "echo local");
    let empty = tempfile::tempdir().unwrap();
    let bins = Binaries::from_search_path(empty.path().into()).with_home(home.path());
    assert_eq!(
        bins.find(Provider::Claude).unwrap(),
        (local, BinarySource::InstallFolder)
    );
}

#[test]
fn a_current_copy_on_path_wins_over_the_older_local_install() {
    // 3.0.0 found this one on PATH; a copy of the old local install left behind must not win.
    let home = tempfile::tempdir().unwrap();
    script(&home.path().join(".claude/local/claude"), "echo old");
    let path = tempfile::tempdir().unwrap();
    let current = script(&path.path().join("claude"), "echo current");
    let bins = Binaries::from_search_path(path.path().into()).with_home(home.path());
    assert_eq!(
        bins.find(Provider::Claude).unwrap(),
        (current, BinarySource::Path)
    );
}

#[test]
fn only_cursors_own_name_is_trusted_ahead_of_path() {
    let home = tempfile::tempdir().unwrap();
    // Some other program called `agent` in ~/.local/bin is not taken for Cursor's.
    script(&home.path().join(".local/bin/agent"), "echo other");
    let path = tempfile::tempdir().unwrap();
    let on_path = script(&path.path().join("agent"), "echo cursor");
    let bins = Binaries::from_search_path(path.path().into()).with_home(home.path());
    assert_eq!(
        bins.find(Provider::Cursor).unwrap(),
        (on_path, BinarySource::Path)
    );
    let cursor = script(&home.path().join(".local/bin/cursor-agent"), "echo cursor");
    assert_eq!(
        bins.find(Provider::Cursor).unwrap(),
        (cursor, BinarySource::InstallFolder)
    );
}

#[test]
fn a_dangling_link_in_the_install_folder_is_skipped() {
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::os::unix::fs::symlink(home.path().join("gone"), bin.join("claude")).unwrap();
    let path = tempfile::tempdir().unwrap();
    let on_path = script(&path.path().join("claude"), "echo path");
    let bins = Binaries::from_search_path(path.path().into()).with_home(home.path());
    assert_eq!(
        bins.find(Provider::Claude).unwrap(),
        (on_path, BinarySource::Path)
    );
}

#[test]
fn nothing_found_says_where_it_looked() {
    let empty = tempfile::tempdir().unwrap();
    let bins = Binaries::from_search_path(empty.path().into()).with_home(empty.path());
    let message = bins.find(Provider::Amp).unwrap_err().to_string();
    assert!(message.contains("install folder or on PATH"), "{message}");
    assert!(message.contains("choose its file"), "{message}");
}

#[tokio::test]
async fn a_chosen_file_wins_and_is_saved() {
    let home = tempfile::tempdir().unwrap();
    script(&home.path().join(".local/bin/claude"), "echo native");
    let elsewhere = tempfile::tempdir().unwrap();
    let chosen = script(
        &elsewhere.path().join("my-claude"),
        "echo '2.1.0 (Claude Code)'",
    );
    let file = home.path().join("app-data/cli-paths.json");

    let bins = Binaries::from_search_path(elsewhere.path().into())
        .with_home(home.path())
        .with_chosen_paths(ChosenPaths::load(file.clone()).await);
    // A clone made before the choice (an engine already open) sees it too.
    let engine_copy = bins.clone();
    bins.choose(Provider::Claude, Some(chosen.clone()))
        .await
        .unwrap();
    assert_eq!(
        engine_copy.find(Provider::Claude).unwrap(),
        (chosen.clone(), BinarySource::Chosen)
    );

    // Saved, and read back by the next launch.
    let reloaded = Binaries::default().with_chosen_paths(ChosenPaths::load(file.clone()).await);
    assert_eq!(
        reloaded.chosen_paths().get(&Provider::Claude),
        Some(&chosen)
    );

    // A chosen file that disappears is reported, not replaced by the install folder's copy.
    std::fs::remove_file(&chosen).unwrap();
    let message = bins.find(Provider::Claude).unwrap_err().to_string();
    assert!(message.contains("choose it again"), "{message}");

    // Preflight still names the choice, so the UI can offer to go back to finding it.
    let report = check(Provider::Claude, &bins).await;
    assert_eq!(report.binary, None);
    assert_eq!(report.chosen.as_deref(), Some(chosen.as_path()));

    // Going back to finding it.
    bins.choose(Provider::Claude, None).await.unwrap();
    assert_eq!(
        bins.find(Provider::Claude).unwrap().1,
        BinarySource::InstallFolder
    );
    let reloaded = Binaries::default().with_chosen_paths(ChosenPaths::load(file).await);
    assert!(reloaded.chosen_paths().is_empty());
}

#[tokio::test]
async fn an_unreadable_choices_file_is_moved_aside_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("cli-paths.json");
    std::fs::write(&file, "{ not json").unwrap();
    let chosen = ChosenPaths::load(file.clone()).await;
    assert!(chosen.all().is_empty());
    assert!(!file.exists());
    let aside: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.starts_with("cli-paths.json.unreadable-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join(&aside[0])).unwrap(),
        "{ not json"
    );
}

#[tokio::test]
async fn only_a_runnable_file_can_be_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let bins = Binaries::from_search_path(dir.path().into());

    let relative = bins
        .choose(Provider::Claude, Some(PathBuf::from("bin/claude")))
        .await
        .unwrap_err();
    assert!(
        relative.to_string().contains("not a full path"),
        "{relative}"
    );

    let plain = dir.path().join("notes.txt");
    std::fs::write(&plain, "hello").unwrap();
    let not_exec = bins
        .choose(Provider::Claude, Some(plain))
        .await
        .unwrap_err();
    assert!(
        not_exec.to_string().contains("not an executable"),
        "{not_exec}"
    );

    let broken = script(&dir.path().join("broken"), "echo 'bad install' >&2; exit 3");
    let fails = bins
        .choose(Provider::Claude, Some(broken))
        .await
        .unwrap_err();
    assert!(fails.to_string().contains("bad install"), "{fails}");

    // Another program that answers --version is not Claude Code.
    let git_like = script(&dir.path().join("git"), "echo 'git version 2.50.0'");
    let wrong = bins
        .choose(Provider::Claude, Some(git_like))
        .await
        .unwrap_err();
    assert!(wrong.to_string().contains("is not Claude Code"), "{wrong}");

    let mock = script(&dir.path().join("mock"), "echo 1");
    assert!(bins.choose(Provider::Mock, Some(mock)).await.is_err());

    // Nothing was kept from the refused choices.
    assert!(bins.chosen_paths().is_empty());
}

#[tokio::test]
async fn an_old_cli_without_auth_status_is_named() {
    // An old npm copy: `--version` works, `auth status` is an unknown command.
    let home = tempfile::tempdir().unwrap();
    let old = script(
        &home.path().join(".local/bin/claude"),
        r#"case "$1" in
  --version) echo '0.2.9 (Claude Code)' ;;
  *) echo "error: unknown command '$1'" >&2; exit 1 ;;
esac"#,
    );
    let empty = tempfile::tempdir().unwrap();
    let bins = Binaries::from_search_path(empty.path().into()).with_home(home.path());
    let report = check(Provider::Claude, &bins).await;
    assert_eq!(report.binary.as_deref(), Some(old.as_path()));
    assert_eq!(report.source, Some(BinarySource::InstallFolder));
    assert_eq!(report.logged_in, None);
    let problem = report.problem.unwrap();
    assert!(problem.contains(&old.display().to_string()), "{problem}");
    assert!(problem.contains("0.2.9"), "{problem}");
    assert!(problem.contains("choose another file"), "{problem}");
}
