//! "Open in terminal": a terminal window at a task's worktree (the task folder in a workspace).
//!
//! The terminal is the one chosen in the app settings (`AppSettings::terminal`) when it is
//! installed, else the first one found. Each opens the folder its own way:
//!
//! * macOS: Terminal, iTerm and Warp with `open -a <app> <folder>`; Ghostty, WezTerm and kitty
//!   start a new instance given the folder (`open -na <app> --args …`).
//! * Windows: Windows Terminal (`wt -d <folder>`), else PowerShell in a new console window (the
//!   app's child processes otherwise get none).
//! * Linux: the chosen terminal with its working-directory flag, else `x-terminal-emulator` started
//!   in the folder.

use std::path::{Path, PathBuf};

use ca_core::agent::Binaries;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalId {
    Terminal,
    Iterm,
    Ghostty,
    Warp,
    Wezterm,
    Kitty,
    WindowsTerminal,
    Powershell,
    Gnome,
    Konsole,
    Alacritty,
    Default,
}

impl TerminalId {
    pub fn label(self) -> &'static str {
        match self {
            TerminalId::Terminal => "Terminal",
            TerminalId::Iterm => "iTerm",
            TerminalId::Ghostty => "Ghostty",
            TerminalId::Warp => "Warp",
            TerminalId::Wezterm => "WezTerm",
            TerminalId::Kitty => "kitty",
            TerminalId::WindowsTerminal => "Windows Terminal",
            TerminalId::Powershell => "PowerShell",
            TerminalId::Gnome => "GNOME Terminal",
            TerminalId::Konsole => "Konsole",
            TerminalId::Alacritty => "Alacritty",
            TerminalId::Default => "Default terminal",
        }
    }

    /// The terminals this system can have, in the order they are offered.
    pub fn for_this_os() -> &'static [TerminalId] {
        if cfg!(target_os = "macos") {
            &[
                TerminalId::Terminal,
                TerminalId::Iterm,
                TerminalId::Ghostty,
                TerminalId::Warp,
                TerminalId::Wezterm,
                TerminalId::Kitty,
            ]
        } else if cfg!(windows) {
            &[TerminalId::WindowsTerminal, TerminalId::Powershell]
        } else {
            &[
                TerminalId::Default,
                TerminalId::Gnome,
                TerminalId::Konsole,
                TerminalId::Kitty,
                TerminalId::Wezterm,
                TerminalId::Alacritty,
            ]
        }
    }
}

/// `native.ts`'s `Terminal`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub id: TerminalId,
    pub label: &'static str,
    pub available: bool,
}

/// How to start a terminal at a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Start the program in the folder (for terminals that open where they are started).
    pub cwd: bool,
    /// Windows: give it a console window of its own.
    pub new_console: bool,
}

/// macOS app bundles, by terminal.
fn mac_bundle(id: TerminalId) -> &'static [&'static str] {
    match id {
        TerminalId::Terminal => &[
            "/System/Applications/Utilities/Terminal.app",
            "/Applications/Utilities/Terminal.app",
        ],
        TerminalId::Iterm => &["/Applications/iTerm.app"],
        TerminalId::Ghostty => &["/Applications/Ghostty.app"],
        TerminalId::Warp => &["/Applications/Warp.app"],
        TerminalId::Wezterm => &["/Applications/WezTerm.app"],
        TerminalId::Kitty => &["/Applications/kitty.app"],
        _ => &[],
    }
}

/// How `id` opens `folder` here, if it is installed. `exists` and `search` are the file system
/// and the `PATH` (replaced in tests).
pub fn launch_for(
    id: TerminalId,
    folder: &Path,
    exists: &dyn Fn(&Path) -> bool,
    search: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<Launch> {
    let dir = folder.to_string_lossy().into_owned();
    let launch = |program: PathBuf, args: Vec<String>| Launch {
        program,
        args,
        cwd: false,
        new_console: false,
    };
    if cfg!(target_os = "macos") {
        let bundle = mac_bundle(id).iter().map(Path::new).find(|p| exists(p))?;
        let bundle = bundle.to_string_lossy().into_owned();
        let open = PathBuf::from("/usr/bin/open");
        let args = match id {
            TerminalId::Ghostty => vec![
                "-na".into(),
                bundle,
                "--args".into(),
                format!("--working-directory={dir}"),
            ],
            TerminalId::Wezterm => vec![
                "-na".into(),
                bundle,
                "--args".into(),
                "start".into(),
                "--cwd".into(),
                dir,
            ],
            TerminalId::Kitty => vec![
                "-na".into(),
                bundle,
                "--args".into(),
                "--directory".into(),
                dir,
            ],
            _ => vec!["-a".into(), bundle, dir],
        };
        return Some(launch(open, args));
    }
    if cfg!(windows) {
        return match id {
            TerminalId::WindowsTerminal => {
                search("wt").map(|wt| launch(wt, vec!["-d".into(), dir]))
            }
            TerminalId::Powershell => {
                search("pwsh")
                    .or_else(|| search("powershell"))
                    .map(|ps| Launch {
                        program: ps,
                        args: vec!["-NoExit".into()],
                        cwd: true,
                        new_console: true,
                    })
            }
            _ => None,
        };
    }
    let (name, args): (&str, Vec<String>) = match id {
        TerminalId::Default => ("x-terminal-emulator", vec![]),
        TerminalId::Gnome => ("gnome-terminal", vec![format!("--working-directory={dir}")]),
        TerminalId::Konsole => ("konsole", vec!["--workdir".into(), dir]),
        TerminalId::Kitty => ("kitty", vec!["--directory".into(), dir]),
        TerminalId::Wezterm => ("wezterm", vec!["start".into(), "--cwd".into(), dir]),
        TerminalId::Alacritty => ("alacritty", vec!["--working-directory".into(), dir]),
        _ => return None,
    };
    search(name).map(|program| Launch {
        program,
        args,
        // Each also starts in the folder, for terminals that ignore the flag.
        cwd: true,
        new_console: false,
    })
}

fn system_exists(p: &Path) -> bool {
    p.exists()
}

/// The terminals of this system and whether each is installed.
pub fn detect(bins: &Binaries) -> Vec<Terminal> {
    let here = Path::new(".");
    TerminalId::for_this_os()
        .iter()
        .map(|&id| Terminal {
            id,
            label: id.label(),
            available: launch_for(id, here, &system_exists, &|n| bins.search(n)).is_some(),
        })
        .collect()
}

/// Open `folder` in `chosen` if it is installed, else in the first terminal found.
pub async fn open(
    chosen: Option<TerminalId>,
    folder: &Path,
    bins: &Binaries,
) -> Result<(), String> {
    let search = |n: &str| bins.search(n);
    let launch = chosen
        .into_iter()
        .chain(TerminalId::for_this_os().iter().copied())
        .find_map(|id| launch_for(id, folder, &system_exists, &search))
        .ok_or_else(|| "no terminal app was found".to_string())?;
    let mut cmd = ca_core::proc::command(&launch.program);
    cmd.args(&launch.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if launch.cwd {
        cmd.current_dir(folder);
    }
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    if launch.new_console {
        // `proc::command` hides the console of the app's own children; a shell needs one.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    #[cfg(not(windows))]
    let _ = launch.new_console;
    // A terminal stays open after we return; it is not ours to wait for or kill.
    cmd.kill_on_drop(false);
    cmd.spawn()
        .map(drop)
        .map_err(|e| format!("could not start {}: {e}", launch.program.display()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn mac_terminals_open_the_folder() {
        let folder = Path::new("/w/task 1");
        let all = |_: &Path| true;
        let none = |_: &str| None;
        let terminal = launch_for(TerminalId::Terminal, folder, &all, &none);
        assert_eq!(
            terminal.map(|l| l.args),
            Some(vec![
                "-a".to_string(),
                "/System/Applications/Utilities/Terminal.app".into(),
                "/w/task 1".into()
            ])
        );
        let ghostty = launch_for(TerminalId::Ghostty, folder, &all, &none);
        assert_eq!(
            ghostty.map(|l| l.args.last().cloned()),
            Some(Some("--working-directory=/w/task 1".into()))
        );
        let nothing = |_: &Path| false;
        assert_eq!(launch_for(TerminalId::Iterm, folder, &nothing, &none), None);
        assert_eq!(launch_for(TerminalId::Konsole, folder, &all, &none), None);
    }

    #[test]
    #[cfg(all(unix, not(target_os = "macos")))]
    fn linux_terminals_get_the_folder_and_start_in_it() {
        let folder = Path::new("/w/t");
        let found = |n: &str| Some(PathBuf::from(format!("/usr/bin/{n}")));
        let gnome = launch_for(TerminalId::Gnome, folder, &|_| false, &found).unwrap();
        assert_eq!(gnome.args, ["--working-directory=/w/t"]);
        assert!(gnome.cwd);
        assert_eq!(
            launch_for(TerminalId::Default, folder, &|_| false, &|_| None),
            None
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_terminal_or_a_powershell_console() {
        let folder = Path::new(r"C:\w\t");
        let found = |n: &str| Some(PathBuf::from(format!(r"C:\bin\{n}.exe")));
        let wt = launch_for(TerminalId::WindowsTerminal, folder, &|_| false, &found).unwrap();
        assert_eq!(wt.args, ["-d", r"C:\w\t"]);
        let ps = launch_for(TerminalId::Powershell, folder, &|_| false, &found).unwrap();
        assert!(ps.new_console && ps.cwd);
    }
}
