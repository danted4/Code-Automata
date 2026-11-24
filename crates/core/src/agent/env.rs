//! Finding agent CLIs.
//!
//! An app launched from the Dock or Finder gets a bare `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`),
//! where none of the agent CLIs are. The user's login shell knows the real `PATH`, so it is asked
//! once (`$SHELL -ilc 'printf %s "$PATH"'`) and binaries are then searched for in it here. The
//! shell is never asked per binary: `command -v` returns alias text for aliases (e.g. `code`).
//!
//! The same `PATH` is passed to agent processes, so the tools they run (node, git, cargo) are found
//! too. Resolve at every launch rather than caching across launches: version managers (nvm) move
//! binaries when the default version changes.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::task::Provider;

/// The executable name each provider is found under.
pub fn binary_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude",
        Provider::Cursor => "agent",
        Provider::Amp => "amp",
        Provider::Mock => "mock-agent",
    }
}

/// Where to find each provider's CLI.
#[derive(Debug, Clone, Default)]
pub struct Binaries {
    search_path: Option<OsString>,
    overrides: HashMap<Provider, PathBuf>,
}

impl Binaries {
    /// Search this process's own `PATH`. Right for tests and for an app started from a terminal.
    pub fn from_env() -> Self {
        Binaries {
            search_path: std::env::var_os("PATH"),
            overrides: HashMap::new(),
        }
    }

    /// Search the `PATH` the user's login shell reports, falling back to this process's `PATH`
    /// if the shell cannot be run. Right for an app started from the Dock or Finder.
    pub async fn from_login_shell() -> Self {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
        let out = tokio::process::Command::new(&shell)
            .args(["-ilc", "printf '%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let path = match tokio::time::timeout(std::time::Duration::from_secs(10), out).await {
            Ok(Ok(out)) if out.status.success() && !out.stdout.is_empty() => {
                // A login shell may print a banner first; PATH is the last line.
                let text = String::from_utf8_lossy(&out.stdout);
                text.lines().last().map(|l| OsString::from(l.trim()))
            }
            _ => None,
        };
        Binaries {
            search_path: path.or_else(|| std::env::var_os("PATH")),
            overrides: HashMap::new(),
        }
    }

    /// Use exactly this file for `provider` (from user settings, or a test's mock binary).
    pub fn with_override(mut self, provider: Provider, path: impl Into<PathBuf>) -> Self {
        self.overrides.insert(provider, path.into());
        self
    }

    /// The `PATH` to give agent processes.
    pub fn path_var(&self) -> Option<&OsStr> {
        self.search_path.as_deref()
    }

    pub fn locate(&self, provider: Provider) -> Result<PathBuf> {
        if let Some(path) = self.overrides.get(&provider) {
            return if is_executable(path) {
                Ok(path.clone())
            } else {
                Err(CoreError::Invalid(format!(
                    "the configured {} binary {} is not an executable file",
                    binary_name(provider),
                    path.display()
                )))
            };
        }
        let name = binary_name(provider);
        self.search_path
            .as_deref()
            .into_iter()
            .flat_map(std::env::split_paths)
            .map(|dir| dir.join(name))
            .find(|candidate| is_executable(candidate))
            .ok_or_else(|| {
                CoreError::Invalid(format!(
                    "`{name}` was not found on PATH; install it or set its path in settings"
                ))
            })
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}
