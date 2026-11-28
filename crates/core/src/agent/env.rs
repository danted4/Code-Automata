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
//!
//! An agent CLI is looked for, in order:
//!
//! 1. in the file the user chose for it (`ChosenPaths`, kept per machine);
//! 2. in its own installer's folder (`install_locations`), before `PATH`: someone who moved from
//!    an npm install (often under nvm) to the native one with `claude install` can still have the
//!    old npm copy earlier on `PATH`. Only names the installer itself writes there, so an
//!    unrelated program cannot be taken for an agent;
//! 3. on the `PATH`;
//! 4. in the folders of node versions other than the active one (nvm, fnm), newest first: an npm
//!    install under another version is not on the login shell's `PATH`. Such a CLI is run with
//!    its version's folder first on its `PATH`, so `#!/usr/bin/env node` finds the node it was
//!    installed with ([`Binaries::path_for_binary`]);
//! 5. in folders of older installs (`legacy_locations`), after `PATH` so a current copy on `PATH`
//!    wins over one left behind: the older Claude Code local install was reached through a shell
//!    alias, which no `PATH` search sees.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::task::Provider;

/// How long a chosen file may take to answer `--version`.
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

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

/// The files each provider's current installer puts its CLI in, relative to the home folder, in
/// the order they are tried. Checked before `PATH` (see the module docs).
pub fn install_locations(provider: Provider, home: &Path) -> Vec<PathBuf> {
    let relative: &[&str] = match provider {
        // The native installer (`claude install`).
        Provider::Claude if cfg!(windows) => &[".local/bin/claude.exe"],
        Provider::Claude => &[".local/bin/claude"],
        // Cursor's installer links both `agent` and `cursor-agent` to the same file; `agent` is
        // too common a name to trust ahead of PATH, so only the specific one is used here.
        Provider::Cursor if cfg!(windows) => &[],
        Provider::Cursor => &[".local/bin/cursor-agent"],
        Provider::Amp if cfg!(windows) => &[],
        Provider::Amp => &[".amp/bin/amp"],
        Provider::Mock => &[],
    };
    relative.iter().map(|r| home.join(r)).collect()
}

/// Files of older installs, relative to the home folder: tried after `PATH`.
pub fn legacy_locations(provider: Provider, home: &Path) -> Vec<PathBuf> {
    let relative: &[&str] = match provider {
        // The older Claude Code local install, reached through a shell alias.
        Provider::Claude if !cfg!(windows) => &[".claude/local/claude"],
        _ => &[],
    };
    relative.iter().map(|r| home.join(r)).collect()
}

/// How a provider's CLI was found.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BinarySource {
    /// The file the user chose for it.
    Chosen,
    /// Set by the program (the mock agent, a test's binary).
    Configured,
    /// The provider's own install folder.
    InstallFolder,
    /// The `PATH`.
    Path,
    /// The folder of a node version that is not the active one (nvm, fnm).
    NodeVersion,
}

/// The CLI file the user chose for each provider, shared by every clone of the `Binaries` that
/// holds it, so a choice reaches the engines already open. Saved to a file when there is one.
#[derive(Debug, Clone, Default)]
pub struct ChosenPaths {
    paths: Arc<RwLock<BTreeMap<Provider, PathBuf>>>,
    file: Option<Arc<PathBuf>>,
    /// Serialises changes, so two at once cannot save an older map last.
    writing: Arc<tokio::sync::Mutex<()>>,
}

/// The file `ChosenPaths` is saved in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChosenPathsFile {
    schema: u32,
    paths: BTreeMap<Provider, PathBuf>,
}

impl ChosenPaths {
    /// Load the choices saved in `file`, which is also where changes go. A missing file means no
    /// choices. One that cannot be read (damaged, or from a newer version) is moved aside to
    /// `<file>.unreadable-<ms>` and reported, so the next change does not overwrite it.
    pub async fn load(file: PathBuf) -> Self {
        let paths = match tokio::fs::read(&file).await {
            Ok(bytes) => match serde_json::from_slice::<ChosenPathsFile>(&bytes) {
                Ok(saved) if saved.schema == 1 => saved.paths,
                Ok(saved) => {
                    set_aside(&file, &format!("unknown schema {}", saved.schema)).await;
                    BTreeMap::new()
                }
                Err(e) => {
                    set_aside(&file, &e.to_string()).await;
                    BTreeMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => {
                log::warn!("{}: {e}", file.display());
                BTreeMap::new()
            }
        };
        ChosenPaths {
            paths: Arc::new(RwLock::new(paths)),
            file: Some(Arc::new(file)),
            writing: Arc::default(),
        }
    }

    /// The choice for one provider, whether or not the file still works.
    pub fn get(&self, provider: Provider) -> Option<PathBuf> {
        self.read().get(&provider).cloned()
    }

    pub fn all(&self) -> BTreeMap<Provider, PathBuf> {
        self.read().clone()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<Provider, PathBuf>> {
        // A writer cannot panic while holding the lock (it only inserts), so a poisoned lock
        // still holds a whole map.
        self.paths
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn set(&self, provider: Provider, path: Option<PathBuf>) -> Result<()> {
        let _writing = self.writing.lock().await;
        let mut next = self.all();
        match path {
            Some(path) => next.insert(provider, path),
            None => next.remove(&provider),
        };
        if let Some(file) = &self.file {
            let saved = ChosenPathsFile {
                schema: 1,
                paths: next.clone(),
            };
            crate::store::write_json_atomic(file, &saved).await?;
        }
        *self
            .paths
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        Ok(())
    }
}

async fn set_aside(file: &Path, why: &str) {
    let mut aside = file.as_os_str().to_owned();
    aside.push(format!(".unreadable-{}", crate::util::now_ms()));
    match tokio::fs::rename(file, &aside).await {
        Ok(()) => log::warn!(
            "{}: {why}; moved to {} and starting with no chosen CLI files",
            file.display(),
            Path::new(&aside).display()
        ),
        Err(e) => log::warn!("{}: {why}; could not move it aside: {e}", file.display()),
    }
}

/// Where to find each provider's CLI.
#[derive(Debug, Clone, Default)]
pub struct Binaries {
    search_path: Option<OsString>,
    /// The home folder whose install folders are searched; none in tests unless set.
    home: Option<PathBuf>,
    /// Where node version managers keep their versions when not in their default folder under
    /// `home` (`NVM_DIR`, `NVM_HOME`): read from the real environment only by
    /// [`Binaries::from_login_shell`], so tests never see the machine's own.
    node_roots: Vec<PathBuf>,
    chosen: ChosenPaths,
    overrides: HashMap<Provider, PathBuf>,
    tools: HashMap<String, PathBuf>,
}

/// The user's home folder, from the environment.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

impl Binaries {
    /// Search this process's own `PATH` only (no install folders). Right for tests and for an app
    /// started from a terminal.
    pub fn from_env() -> Self {
        Binaries {
            search_path: std::env::var_os("PATH"),
            ..Binaries::default()
        }
    }

    /// Search exactly this `PATH`-style list of folders (no install folders).
    pub fn from_search_path(path: OsString) -> Self {
        Binaries {
            search_path: Some(path),
            ..Binaries::default()
        }
    }

    /// Also search the install folders under `home` (`from_login_shell` uses the real one).
    pub fn with_home(mut self, home: impl Into<PathBuf>) -> Self {
        self.home = Some(home.into());
        self
    }

    /// Use, and save changes to, these chosen CLI files.
    pub fn with_chosen_paths(mut self, chosen: ChosenPaths) -> Self {
        self.chosen = chosen;
        self
    }

    /// The CLI file the user chose for each provider.
    pub fn chosen_paths(&self) -> BTreeMap<Provider, PathBuf> {
        self.chosen.all()
    }

    /// Choose the CLI file for `provider`, or go back to finding it (`None`). The file must be an
    /// absolute path to an executable that answers `--version`.
    pub async fn choose(&self, provider: Provider, path: Option<PathBuf>) -> Result<()> {
        if provider == Provider::Mock {
            return Err(CoreError::Invalid(
                "the mock agent's file cannot be chosen".into(),
            ));
        }
        if let Some(path) = &path {
            self.check_chosen(provider, path).await?;
        }
        self.chosen.set(provider, path).await
    }

    async fn check_chosen(&self, provider: Provider, path: &Path) -> Result<()> {
        let name = binary_name(provider);
        if !path.is_absolute() {
            return Err(CoreError::Invalid(format!(
                "{} is not a full path; give the whole path to the {name} file",
                path.display()
            )));
        }
        if !is_executable(path) {
            return Err(CoreError::Invalid(format!(
                "{} is not an executable file",
                path.display()
            )));
        }
        let mut cmd = crate::proc::command(path);
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Some(search) = &self.search_path {
            cmd.env("PATH", search);
        }
        match tokio::time::timeout(VERSION_TIMEOUT, cmd.output()).await {
            // Claude Code names itself in its version ("2.1.0 (Claude Code)"), so another program
            // chosen by mistake is caught here. Cursor's and Amp's print only a number.
            Ok(Ok(out))
                if out.status.success()
                    && provider == Provider::Claude
                    && !String::from_utf8_lossy(&out.stdout).contains("Claude Code") =>
            {
                Err(CoreError::Invalid(format!(
                    "{} is not Claude Code: its --version says {:?}",
                    path.display(),
                    String::from_utf8_lossy(&out.stdout).trim()
                )))
            }
            Ok(Ok(out)) if out.status.success() => Ok(()),
            Ok(Ok(out)) => Err(CoreError::Invalid(format!(
                "{} --version failed: {}",
                path.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ))),
            Ok(Err(e)) => Err(CoreError::Invalid(format!(
                "{} could not be run: {e}",
                path.display()
            ))),
            Err(_) => Err(CoreError::Invalid(format!(
                "{} --version did not answer within {} seconds",
                path.display(),
                VERSION_TIMEOUT.as_secs()
            ))),
        }
    }

    /// Search the `PATH` the user's login shell reports, falling back to this process's `PATH`
    /// if the shell cannot be run or reports something that is not a usable `PATH`. Right for an
    /// app started from the Dock or Finder.
    pub async fn from_login_shell() -> Self {
        if cfg!(windows) {
            return Binaries {
                home: home_dir(),
                node_roots: node_roots_from_env(),
                ..Self::from_env()
            };
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
        let out = crate::proc::command(&shell)
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
            home: home_dir(),
            node_roots: node_roots_from_env(),
            ..Binaries::default()
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

    /// The home folder whose install folders are searched, if any.
    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// The `PATH` to give agent processes.
    pub fn path_var(&self) -> Option<&OsStr> {
        self.search_path.as_deref()
    }

    /// The `PATH` to run `binary` with: [`Binaries::path_var`], with the binary's own folder first
    /// when that folder holds a `node` and is not already on it (an npm CLI under a node version
    /// that is not the active one, whose script needs that version's node).
    pub fn path_for_binary(&self, binary: &Path) -> Option<OsString> {
        let base = self.search_path.clone();
        let Some(dir) = binary.parent().filter(|d| has_node(d)) else {
            return base;
        };
        let mut entries: Vec<PathBuf> = base
            .as_deref()
            .map(|p| std::env::split_paths(p).collect())
            .unwrap_or_default();
        if entries.iter().any(|e| e == dir) {
            return base;
        }
        entries.insert(0, dir.to_path_buf());
        std::env::join_paths(entries).ok().or(base)
    }

    pub fn locate(&self, provider: Provider) -> Result<PathBuf> {
        self.find(provider).map(|(path, _)| path)
    }

    /// The provider's CLI and how it was found (see the module docs for the order).
    pub fn find(&self, provider: Provider) -> Result<(PathBuf, BinarySource)> {
        let name = binary_name(provider);
        if let Some(path) = self.overrides.get(&provider) {
            return if is_executable(path) {
                Ok((path.clone(), BinarySource::Configured))
            } else {
                Err(CoreError::Invalid(format!(
                    "the configured {name} binary {} is not an executable file",
                    path.display()
                )))
            };
        }
        if provider != Provider::Mock
            && let Some(path) = self.chosen.get(provider)
        {
            // A chosen file that went away is reported, not silently replaced by another copy.
            return if is_executable(&path) {
                Ok((path, BinarySource::Chosen))
            } else {
                Err(CoreError::Invalid(format!(
                    "the {name} file you chose, {}, is not an executable file any more; choose \
                     it again",
                    path.display()
                )))
            };
        }
        if let Some(home) = &self.home
            && let Some(path) = install_locations(provider, home)
                .into_iter()
                .find(|p| is_executable(p))
        {
            return Ok((path, BinarySource::InstallFolder));
        }
        if let Some(path) = self.search(name) {
            return Ok((path, BinarySource::Path));
        }
        if let Some(home) = &self.home {
            let names = executable_names(name, std::env::var_os("PATHEXT").as_deref());
            if let Some(path) = node_version_dirs(home, &self.node_roots)
                .iter()
                .flat_map(|dir| names.iter().map(|n| dir.join(n)).collect::<Vec<_>>())
                .find(|candidate| is_executable(candidate))
            {
                return Ok((path, BinarySource::NodeVersion));
            }
        }
        self.home
            .as_deref()
            .and_then(|home| {
                legacy_locations(provider, home)
                    .into_iter()
                    .find(|p| is_executable(p))
            })
            .map(|path| (path, BinarySource::InstallFolder))
            .ok_or_else(|| {
                CoreError::Invalid(format!(
                    "`{name}` was not found in its install folder or on PATH; install it, or \
                     choose its file"
                ))
            })
    }

    /// The first executable called `name` on the search path.
    pub fn search(&self, name: &str) -> Option<PathBuf> {
        let names = executable_names(name, std::env::var_os("PATHEXT").as_deref());
        self.search_path
            .as_deref()
            .into_iter()
            .flat_map(std::env::split_paths)
            .flat_map(|dir| names.iter().map(|n| dir.join(n)).collect::<Vec<_>>())
            .find(|candidate| is_executable(candidate))
    }
}

/// Whether `dir` holds a node executable.
fn has_node(dir: &Path) -> bool {
    ["node", "node.exe"]
        .iter()
        .any(|n| is_executable(&dir.join(n)))
}

/// `NVM_DIR` and, on Windows, `NVM_HOME`, when set.
fn node_roots_from_env() -> Vec<PathBuf> {
    ["NVM_DIR", "NVM_HOME"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}

/// The folders npm puts global CLIs in, one per installed node version, newest version first:
/// nvm's (`~/.nvm`, or `NVM_DIR` among `roots`), fnm's, and on Windows nvm-windows'
/// (`%APPDATA%\nvm`, or `NVM_HOME` among `roots`).
pub fn node_version_dirs(home: &Path, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut found: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    let mut scan = |root: PathBuf, bin: &dyn Fn(&Path) -> PathBuf| {
        let Ok(entries) = std::fs::read_dir(&root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(version) = parse_version(&name) {
                found.push((version, bin(&entry.path())));
            }
        }
    };
    let mut nvm_dirs = vec![home.join(".nvm")];
    nvm_dirs.extend(roots.iter().cloned());
    nvm_dirs.dedup();
    for nvm in &nvm_dirs {
        scan(nvm.join("versions").join("node"), &|v| v.join("bin"));
    }
    for fnm in [
        home.join(".local/share/fnm/node-versions"),
        home.join("Library/Application Support/fnm/node-versions"),
        home.join(".fnm/node-versions"),
    ] {
        scan(fnm, &|v| v.join("installation").join("bin"));
    }
    if cfg!(windows) {
        scan(home.join("AppData").join("Roaming").join("nvm"), &|v| {
            v.to_path_buf()
        });
        for root in roots {
            scan(root.clone(), &|v| v.to_path_buf());
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut dirs: Vec<PathBuf> = found.into_iter().map(|(_, dir)| dir).collect();
    dirs.dedup();
    dirs
}

/// "v22.11.0" or "22.11.0" as numbers, for ordering versions (v9 before v22).
fn parse_version(name: &str) -> Option<Vec<u64>> {
    let digits = name.strip_prefix('v').unwrap_or(name);
    let parts: Option<Vec<u64>> = digits.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
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

    #[tokio::test]
    async fn the_app_searches_the_install_folders_on_every_os() {
        // Windows has no login shell step; the home folder must still be set there.
        let bins = Binaries::from_login_shell().await;
        assert!(bins.home().is_some());
        assert_eq!(bins.home().map(Path::to_path_buf), home_dir());
    }

    #[test]
    #[cfg(windows)]
    fn the_native_install_wins_on_windows_too() {
        let home = tempfile::tempdir().unwrap();
        let native = home.path().join(".local/bin/claude.exe");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "").unwrap();
        // An old npm shim on PATH.
        let npm = tempfile::tempdir().unwrap();
        std::fs::write(npm.path().join("claude.cmd"), "@echo off").unwrap();
        let bins = Binaries::from_search_path(npm.path().into()).with_home(home.path());
        assert_eq!(
            bins.find(Provider::Claude).unwrap(),
            (native, BinarySource::InstallFolder)
        );
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
