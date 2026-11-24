//! Cursor and VS Code: which are installed, and opening a folder in one.
//!
//! An editor is installed when its command-line launcher is on the login shell's `PATH`, or its
//! app is where its installer puts it. Opening prefers the app (macOS: `open -a`; elsewhere the
//! app's own executable), since a GUI executable needs no shell, then the launcher.

use std::path::{Path, PathBuf};

use ca_core::agent::Binaries;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorId {
    Cursor,
    Vscode,
}

impl EditorId {
    pub const ALL: [EditorId; 2] = [EditorId::Cursor, EditorId::Vscode];

    pub fn label(self) -> &'static str {
        match self {
            EditorId::Cursor => "Cursor",
            EditorId::Vscode => "VS Code",
        }
    }

    fn cli(self) -> &'static str {
        match self {
            EditorId::Cursor => "cursor",
            EditorId::Vscode => "code",
        }
    }
}

/// What `native.ts` calls `AvailableEditor`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Editor {
    pub id: EditorId,
    pub label: &'static str,
    pub available: bool,
}

/// Where each editor's app is installed on this OS, given the home and local-app-data folders.
pub fn app_paths(id: EditorId, home: Option<&Path>, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(target_os = "macos") {
        let bundle = match id {
            EditorId::Cursor => "Cursor.app",
            EditorId::Vscode => "Visual Studio Code.app",
        };
        paths.push(Path::new("/Applications").join(bundle));
        if let Some(home) = home {
            paths.push(home.join("Applications").join(bundle));
        }
    } else if cfg!(windows) {
        if let Some(local) = local_app_data {
            paths.push(match id {
                EditorId::Cursor => local.join(r"Programs\Cursor\Cursor.exe"),
                EditorId::Vscode => local.join(r"Programs\Microsoft VS Code\Code.exe"),
            });
        }
        if id == EditorId::Vscode {
            paths.push(PathBuf::from(
                r"C:\Program Files\Microsoft VS Code\Code.exe",
            ));
        }
    } else {
        match id {
            EditorId::Cursor => {
                if let Some(home) = home {
                    paths.push(home.join(".local/share/cursor/cursor"));
                }
                paths.push("/opt/Cursor/cursor".into());
                paths.push("/opt/cursor/cursor".into());
            }
            EditorId::Vscode => {
                paths.push("/usr/share/code/code".into());
                paths.push("/snap/bin/code".into());
            }
        }
    }
    paths
}

/// This machine's app locations.
pub fn system_app_paths(id: EditorId) -> Vec<PathBuf> {
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    app_paths(id, home.as_deref(), local.as_deref())
}

/// How to open a folder in `id`, if it is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// macOS: `open -a <bundle> <folder>`.
    Bundle(PathBuf),
    /// The editor's own executable, or its launcher script, with the folder as its argument.
    Program(PathBuf),
}

pub fn launch_for(id: EditorId, bins: &Binaries, apps: &[PathBuf]) -> Option<Launch> {
    let app = apps.iter().find(|p| p.exists()).cloned();
    match app {
        Some(app) if cfg!(target_os = "macos") => Some(Launch::Bundle(app)),
        Some(app) => Some(Launch::Program(app)),
        None => bins.search(id.cli()).map(Launch::Program),
    }
}

pub fn detect(bins: &Binaries, apps: impl Fn(EditorId) -> Vec<PathBuf>) -> Vec<Editor> {
    EditorId::ALL
        .iter()
        .map(|&id| Editor {
            id,
            label: id.label(),
            available: launch_for(id, bins, &apps(id)).is_some(),
        })
        .collect()
}

/// Open `folder` in the editor. Returns once the editor (or `open`) has started.
pub async fn open(launch: &Launch, folder: &Path, bins: &Binaries) -> Result<(), String> {
    let mut cmd = match launch {
        Launch::Bundle(bundle) => {
            let mut cmd = ca_core::proc::command("open");
            cmd.arg("-a").arg(bundle).arg(folder);
            cmd
        }
        Launch::Program(program) => {
            let mut cmd = ca_core::proc::command(program);
            cmd.arg(folder);
            cmd
        }
    };
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the editor: {e}"))?;
    if matches!(launch, Launch::Bundle(_)) {
        // `open` returns as soon as the app has the request; its status says whether it worked.
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("`open` failed ({status})"));
        }
        return Ok(());
    }
    // A launcher script hands off and exits 0; the editor itself keeps running. A broken one (a
    // stale `cursor` left on PATH) exits non-zero at once, so give it a moment to say so.
    match tokio::time::timeout(EARLY_EXIT, child.wait()).await {
        Ok(Ok(status)) if !status.success() => Err(format!("the editor exited at once ({status})")),
        Ok(Err(e)) => Err(e.to_string()),
        // Still running, or done handing off. It is not stopped when the app quits.
        _ => Ok(()),
    }
}

/// How long a launcher has to fail before the editor counts as opened.
const EARLY_EXIT: std::time::Duration = std::time::Duration::from_millis(1500);

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn fake_path_with(names: &[&str]) -> (tempfile::TempDir, Binaries) {
        let dir = tempfile::tempdir().unwrap();
        for name in names {
            let file = dir.path().join(if cfg!(windows) {
                format!("{name}.cmd")
            } else {
                name.to_string()
            });
            std::fs::write(&file, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let bins = Binaries::from_search_path(dir.path().as_os_str().to_owned());
        (dir, bins)
    }

    #[test]
    fn an_editor_is_available_through_its_launcher_on_path() {
        let (dir, bins) = fake_path_with(&["cursor"]);
        let editors = detect(&bins, |_| Vec::new());
        assert_eq!(
            editors,
            vec![
                Editor {
                    id: EditorId::Cursor,
                    label: "Cursor",
                    available: true
                },
                Editor {
                    id: EditorId::Vscode,
                    label: "VS Code",
                    available: false
                },
            ]
        );
        let launch = launch_for(EditorId::Cursor, &bins, &[]).unwrap();
        let Launch::Program(p) = launch else {
            panic!("{launch:?}")
        };
        assert!(p.starts_with(dir.path()));
    }

    #[test]
    fn an_installed_app_is_preferred_over_the_launcher() {
        let (_dir, bins) = fake_path_with(&["code"]);
        let apps = tempfile::tempdir().unwrap();
        let app = apps.path().join("Code");
        std::fs::create_dir_all(&app).unwrap();
        let launch = launch_for(
            EditorId::Vscode,
            &bins,
            &[apps.path().join("missing"), app.clone()],
        );
        let expected = if cfg!(target_os = "macos") {
            Launch::Bundle(app)
        } else {
            Launch::Program(app)
        };
        assert_eq!(launch, Some(expected));
    }

    #[test]
    fn nothing_installed_means_nothing_available() {
        let (_dir, bins) = fake_path_with(&[]);
        assert!(detect(&bins, |_| Vec::new()).iter().all(|e| !e.available));
    }

    #[test]
    fn app_locations_are_absolute() {
        let home = std::env::temp_dir();
        for id in EditorId::ALL {
            let paths = app_paths(id, Some(&home), Some(&home));
            assert!(!paths.is_empty());
            assert!(paths.iter().all(|p| p.is_absolute()), "{paths:?}");
        }
    }

    #[test]
    fn editor_ids_serialize_as_the_ui_names_them() {
        assert_eq!(
            serde_json::to_string(&EditorId::Vscode).unwrap(),
            "\"vscode\""
        );
        assert_eq!(
            serde_json::from_str::<EditorId>("\"cursor\"").unwrap(),
            EditorId::Cursor
        );
    }
}
