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
//!
//! On Windows a GUI app gets the user's full `PATH` from the environment, so there is no login
//! shell step, and a name is searched with each `PATHEXT` extension (`claude.exe`, `claude.cmd`).

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::task::Provider;

const START: &str = "__CODE_AUTOMATA_PATH_START__";
const END: &str = "__CODE_AUTOMATA_PATH_END__";

/// The `PATH` between the sentinels, if it looks like one: non-empty, and every entry absolute.
/// Anything else (an error message, a relative entry) is rejected so it cannot replace a working
/// `PATH`. Entries may contain spaces (`/Applications/Visual Studio Code.app/...`).
pub fn parse_path_output(output: &str) -> Option<OsString> {
    let start = output.rfind(START)? + START.len();
    let len = output[start..].find(END)?;
    let value = output[start..start + len].trim();
    let entries: Vec<&str> = value.split(':').filter(|e| !e.is_empty()).collect();
    if entries.is_empty() || entries.iter().any(|e| !e.starts_with('/')) {
        return None;
    }
    Some(OsString::from(value))
}

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
    tools: HashMap<String, PathBuf>,
}

impl Binaries {
    /// Search this process's own `PATH`. Right for tests and for an app started from a terminal.
    pub fn from_env() -> Self {
        Binaries {
            search_path: std::env::var_os("PATH"),
            overrides: HashMap::new(),
            tools: HashMap::new(),
        }
    }

    /// Search the `PATH` the user's login shell reports, falling back to this process's `PATH`
    /// if the shell cannot be run or reports something that is not a usable `PATH`. Right for an
    /// app started from the Dock or Finder.
    pub async fn from_login_shell() -> Self {
        if cfg!(windows) {
            return Self::from_env();
        }
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
        let is_fish = Path::new(&shell).file_name().is_some_and(|n| n == "fish");
        // Sentinels around the value, so banners or motd lines printed by shell startup files
        // cannot be mistaken for it. fish keeps PATH as a list and needs it joined.
        let script = if is_fish {
            format!("printf '{START}%s{END}' (string join : $PATH)")
        } else {
            format!("printf '{START}%s{END}' \"$PATH\"")
        };
        let out = tokio::process::Command::new(&shell)
            .args(["-ilc", &script])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let path = match tokio::time::timeout(std::time::Duration::from_secs(10), out).await {
            Ok(Ok(out)) if out.status.success() => {
                parse_path_output(&String::from_utf8_lossy(&out.stdout))
            }
            _ => None,
        };
        Binaries {
            search_path: path.or_else(|| std::env::var_os("PATH")),
            overrides: HashMap::new(),
            tools: HashMap::new(),
        }
    }

    /// Use exactly this file for `provider` (from user settings, or a test's mock binary).
    pub fn with_override(mut self, provider: Provider, path: impl Into<PathBuf>) -> Self {
        self.overrides.insert(provider, path.into());
        self
    }

    /// Use exactly this file for the tool `name` (for example a fake `gh` in tests).
    pub fn with_tool(mut self, name: &str, path: impl Into<PathBuf>) -> Self {
        self.tools.insert(name.to_string(), path.into());
        self
    }

    /// Find a helper tool other than an agent CLI (`gh`), on the same search path.
    pub fn locate_tool(&self, name: &str) -> Result<PathBuf> {
        if let Some(path) = self.tools.get(name) {
            return Ok(path.clone());
        }
        self.search(name).ok_or_else(|| {
            CoreError::Invalid(format!("`{name}` was not found on PATH; install it first"))
        })
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
        self.search(name).ok_or_else(|| {
            CoreError::Invalid(format!(
                "`{name}` was not found on PATH; install it or set its path in settings"
            ))
        })
    }

    /// The first executable called `name` on the search path.
    fn search(&self, name: &str) -> Option<PathBuf> {
        let names = executable_names(name, std::env::var_os("PATHEXT").as_deref());
        self.search_path
            .as_deref()
            .into_iter()
            .flat_map(std::env::split_paths)
            .flat_map(|dir| names.iter().map(|n| dir.join(n)).collect::<Vec<_>>())
            .find(|candidate| is_executable(candidate))
    }
}

/// The file names `name` may have on disk. On Windows, `name` as written if it already has an
/// extension (`gh.exe`), then `name` plus each `PATHEXT` extension in order, the way `cmd`
/// searches (`.COM;.EXE;.BAT;.CMD` when `PATHEXT` is unset or has no usable entry). Elsewhere
/// just `name`.
pub fn executable_names(name: &str, pathext: Option<&OsStr>) -> Vec<OsString> {
    const DEFAULT: &str = ".COM;.EXE;.BAT;.CMD";
    if !cfg!(windows) {
        return vec![OsString::from(name)];
    }
    let exts = |list: &str| -> Vec<String> {
        list.split(';')
            .map(str::trim)
            .filter(|ext| ext.starts_with('.') && ext.len() > 1)
            .map(str::to_ascii_lowercase)
            .collect()
    };
    let mut found = exts(pathext.and_then(OsStr::to_str).unwrap_or(DEFAULT));
    if found.is_empty() {
        found = exts(DEFAULT);
    }
    let mut names = Vec::new();
    if Path::new(name).extension().is_some() {
        names.push(OsString::from(name));
    }
    names.extend(
        found
            .iter()
            .map(|ext| OsString::from(format!("{name}{ext}"))),
    );
    names
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn wrap(v: &str) -> String {
        format!("{START}{v}{END}")
    }

    #[test]
    fn path_output_is_validated() {
        assert_eq!(
            parse_path_output(&format!(
                "Welcome!\nmotd\n{}",
                wrap("/usr/bin:/opt/homebrew/bin")
            )),
            Some(OsString::from("/usr/bin:/opt/homebrew/bin"))
        );
        assert_eq!(
            parse_path_output(&wrap("/usr/bin:/Applications/Visual Studio Code.app/bin")),
            Some(OsString::from(
                "/usr/bin:/Applications/Visual Studio Code.app/bin"
            ))
        );
        // A relative entry, an empty value, an error message, no sentinels.
        for bad in [
            wrap("/usr/bin:bin"),
            wrap("command not found: string"),
            wrap(""),
            "/usr/bin:/bin".to_string(),
        ] {
            assert_eq!(parse_path_output(&bad), None, "{bad:?} was accepted");
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_names_follow_pathext() {
        let names = |ext: Option<&str>| {
            executable_names("claude", ext.map(OsStr::new))
                .into_iter()
                .map(|n| n.into_string().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(Some(".EXE;.CMD")), ["claude.exe", "claude.cmd"]);
        assert_eq!(
            names(None),
            ["claude.com", "claude.exe", "claude.bat", "claude.cmd"]
        );
        assert_eq!(names(Some(" ; .Bat ;junk")), ["claude.bat"]);
        // Set but unusable: the default list.
        assert_eq!(names(Some("EXE;CMD")).len(), 4);
        let exact: Vec<_> = executable_names("gh.exe", Some(OsStr::new(".EXE")))
            .into_iter()
            .map(|n| n.into_string().unwrap())
            .collect();
        assert_eq!(exact, ["gh.exe", "gh.exe.exe"]);
    }

    #[test]
    #[cfg(unix)]
    fn unix_names_are_unchanged() {
        assert_eq!(
            executable_names("claude", Some(OsStr::new(".EXE"))),
            ["claude"]
        );
    }
}
