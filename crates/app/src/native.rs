//! The commands behind `ui/src/lib/native.ts`. Each is listed in `build.rs` and allowed in
//! `capabilities/main.json`; the page can call nothing else.
//!
//! Paths the page sends are checked against the projects the server has open (`paths.rs`).

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::editors::{self, Editor, EditorId};
use crate::paths::inside_open_project;
use crate::server::Server;
use crate::terminals;

/// `native.ts`'s `OpenEditorResult`.
#[derive(Debug, Serialize)]
pub struct OpenResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl From<Result<(), String>> for OpenResult {
    fn from(result: Result<(), String>) -> Self {
        match result {
            Ok(()) => OpenResult {
                success: true,
                error: None,
            },
            Err(e) => {
                log::warn!("{e}");
                OpenResult {
                    success: false,
                    error: Some(e),
                }
            }
        }
    }
}

/// The folder picker; `None` when cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Open a project")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx.await.ok()??;
    let path = folder.into_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// A file picker (an agent's CLI); `None` when cancelled. Only the chosen path is returned; the
/// server checks the file before using it.
#[tauri::command]
pub async fn pick_file(app: AppHandle, title: String) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_file(move |file| {
        let _ = tx.send(file);
    });
    let file = rx.await.ok()??;
    let path = file.into_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn available_editors(server: State<'_, Server>) -> Result<Vec<Editor>, String> {
    let bins = server.bins().await?;
    Ok(editors::detect(&bins, editors::system_app_paths))
}

/// Whether `path` is an existing folder inside an open project (false for anything else).
#[tauri::command]
pub async fn path_exists(server: State<'_, Server>, path: String) -> Result<bool, String> {
    let roots = server.state().await?.open_roots().await;
    Ok(inside_open_project(&path, &roots).is_ok())
}

/// Open a worktree in Cursor or VS Code. `projectPath` from the page is not needed: the folder
/// is checked against every open project.
#[tauri::command]
pub async fn open_in_editor(
    server: State<'_, Server>,
    worktree_path: String,
    editor_id: EditorId,
) -> Result<OpenResult, String> {
    let result = async {
        let roots = server.state().await?.open_roots().await;
        let folder = inside_open_project(&worktree_path, &roots)?;
        let bins = server.bins().await?;
        let launch = editors::launch_for(editor_id, &bins, &editors::system_app_paths(editor_id))
            .ok_or_else(|| format!("{} is not installed", editor_id.label()))?;
        editors::open(&launch, &folder, &bins).await
    }
    .await;
    Ok(result.into())
}

/// The terminals of this system and whether each is installed.
#[tauri::command]
pub async fn available_terminals(
    server: State<'_, Server>,
) -> Result<Vec<terminals::Terminal>, String> {
    let bins = server.bins().await?;
    Ok(terminals::detect(&bins))
}

/// Open a terminal at a worktree (or a workspace task's folder), in the terminal chosen in the app
/// settings, else the first one found.
#[tauri::command]
pub async fn open_in_terminal(
    app: AppHandle,
    server: State<'_, Server>,
    path: String,
) -> Result<OpenResult, String> {
    let result = async {
        let roots = server.state().await?.open_roots().await;
        let folder = inside_open_project(&path, &roots)?;
        let bins = server.bins().await?;
        let chosen = crate::app_settings::load(&app).terminal;
        terminals::open(chosen, &folder, &bins).await
    }
    .await;
    Ok(result.into())
}

/// Show a worktree in Finder, Explorer or the file manager: the folder is selected in its parent,
/// never opened. Opening a folder on macOS launches it if it is an app bundle (`Tool.app`), and
/// an agent can leave one in a worktree.
#[tauri::command]
pub async fn reveal_folder(
    app: AppHandle,
    server: State<'_, Server>,
    worktree_path: String,
) -> Result<OpenResult, String> {
    let result = async {
        let roots = server.state().await?.open_roots().await;
        let folder = inside_open_project(&worktree_path, &roots)?;
        app.opener()
            .reveal_item_in_dir(&folder)
            .map_err(|e| format!("could not show the folder: {e}"))
    }
    .await;
    Ok(result.into())
}
