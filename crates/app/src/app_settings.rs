//! Settings of the app itself, for this computer (not a project's): `app-settings.json` in the
//! app data folder. A missing file means defaults; an unreadable one is moved aside (so the next
//! save does not overwrite something the user may want back) and defaults are used.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub schema: u32,
    /// Look for a new version a few seconds after the app starts.
    #[serde(default = "yes")]
    pub check_updates_at_launch: bool,
}

fn yes() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            schema: SCHEMA,
            check_updates_at_launch: true,
        }
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("app-settings.json"))
}

/// The settings in `path`, or defaults.
pub fn load_from(path: &Path) -> AppSettings {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return AppSettings::default(),
        Err(e) => {
            log::warn!("{}: cannot be read ({e}); using defaults", path.display());
            return AppSettings::default();
        }
    };
    match serde_json::from_slice::<AppSettings>(&bytes) {
        Ok(s) if s.schema == SCHEMA => s,
        Ok(_) => set_aside(path, "unknown schema"),
        Err(e) => set_aside(path, &e.to_string()),
    }
}

fn set_aside(path: &Path, why: &str) -> AppSettings {
    let mut aside = path.as_os_str().to_owned();
    aside.push(format!(".unreadable-{}", ca_core::util::now_ms()));
    match std::fs::rename(path, &aside) {
        Ok(()) => log::warn!(
            "{}: {why}; moved to {} and using defaults",
            path.display(),
            Path::new(&aside).display()
        ),
        Err(e) => log::warn!("{}: {why}; could not move it aside: {e}", path.display()),
    }
    AppSettings::default()
}

pub fn load(app: &AppHandle) -> AppSettings {
    file(app).map_or_else(AppSettings::default, |f| load_from(&f))
}

pub async fn save_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if settings.schema != SCHEMA {
        return Err(format!("app settings: schema must be {SCHEMA}"));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    ca_core::store::write_json_atomic(path, settings)
        .await
        .map_err(|e| e.to_string())
}

/// The app's settings for this computer.
#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> AppSettings {
    load(&app)
}

#[tauri::command]
pub async fn set_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = file(&app).ok_or("the app has no data folder")?;
    save_to(&path, &settings).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_default_to_checking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("app-settings.json");
        assert!(load_from(&path).check_updates_at_launch);
        let off = AppSettings {
            check_updates_at_launch: false,
            ..AppSettings::default()
        };
        tauri::async_runtime::block_on(save_to(&path, &off)).unwrap();
        assert_eq!(load_from(&path), off);
    }

    #[test]
    fn an_unreadable_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app-settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_from(&path).check_updates_at_launch);
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".unreadable-"))
            .collect();
        assert_eq!(aside.len(), 1);
    }
}
