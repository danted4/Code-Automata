# Changelog

All notable changes to Code-Automata are documented here.

---

## 3.1.0 (unreleased)

### New

- **Workspaces: one task across several repositories.** Open a folder that is not a git repository itself but whose every folder is one (hidden folders are ignored), for example `~/work` holding `api/`, `web/` and `infra/`. Each task gets a worktree of every repository; the planner decides which ones the work touches and the card shows them. Each repository that changes is checked in its own worktree and gets its own pull request: Human Review lists one row per repository, "Create pull requests" goes through them all, keeps the ones that worked if another fails, and "Retry failed" finishes the rest. On GitHub each pull request lists the others.
- **Agents in a workspace are told the layout**: which repositories there are, the `CLAUDE.md`, `AGENTS.md` and `.cursor/rules` of each and of the workspace folder, and that only files inside a repository are kept. Files an agent leaves directly in the task folder are removed after the run, and the run log says so.
- **Changes tab** in the task details: the files the task changed in each repository, with lines added and removed.
- **Settings per repository** in a workspace: check commands (else the repository's own saved commands from opening it alone, else detected; the page shows which) and how its pull requests are opened.
- **Updates**: Settings → App updates can turn off the check at launch, and "Check for updates" looks now (it also offers a version that failed to install before).

### Changed

- **A folder inside a repository is no longer opened as that repository.** Open the repository's root (or the workspace folder). A folder is checked every time it is opened: if a workspace gains a folder that is not a repository, it is refused until the folder is moved out or made a repository; its tasks stay safe on disk.
- **Task files move to a new format** (schema 2). 3.1 reads 3.0 task files and rewrites each the next time the task changes; after that, 3.0 can no longer show that task. The in-app updater never goes back to 3.0, so this only matters if you reinstall 3.0 by hand.
- A repository without an `origin` remote is reported as such in Human Review ("No remote: the changes are on code-automata/…"), not as an error.
- After a replan, resuming or skipping a halted subtask only undoes that run's own work, never the earlier plan's commits.

### Known limits

- **"Check for updates" has not been tried against a real release yet**; it will be from 3.1.0 onward. The check at launch works as in 3.0.1.
- **GitLab** is still untested against a real GitLab, and SSH host aliases have not been resolved end to end (as in 3.0.1).

---

## 3.0.1

Fixes from the first feedback on 3.0.0. If you have 3.0.0 installed, it offers this update when it starts.

### Fixed

- **Agent CLIs installed outside your shell's PATH are found.** Each agent is looked for in its own install folder (for Claude Code, `~/.local/bin` from `claude install`) before the PATH, so an old npm copy left behind under nvm no longer hides the native install; the older `~/.claude/local` install, reached through a shell alias, is found after the PATH. When nothing is found, or the login state of the copy found cannot be read, you can choose the file yourself, right in the agent picker or under Settings → Agent CLIs on this computer. The choice is kept for the computer and applies to every project.
- **Pull requests on GitLab and other hosts.** GitLab (gitlab.com and self-hosted, 11.10 or later) merge requests are opened by git itself with push options; no CLI is needed. Any other host gets the branch pushed, and the link the host prints for opening a pull request is kept on the task. The host is detected from `origin`, or set under Settings → Pull requests. GitHub still uses the GitHub CLI, which is now needed only for GitHub.
- The agent picker says how each CLI was found (install folder, PATH or chosen by you), and a copy too old to report its login is named with its path and version.
- A GitHub remote behind an SSH host alias (`git@github-work:org/repo.git`, for a second account) is recognised as GitHub.

### Known limits

- **GitLab has not been tried against a real GitLab.** That covers opening a merge request, updating it after rework, reopening after it was closed, and older versions that ignore push options. It is tested only against a local remote that answers like GitLab. If no merge request appears, the branch is still pushed: choose Settings → Pull requests → Other and open it on GitLab.
- **Resolving an SSH host alias** (with `ssh -G`) is unit-tested but has not run end to end.
- **This is the first release delivered by the in-app updater** (3.0.0 → 3.0.1). If the update fails, download the installer from this page.

---

## 3.0.0

A rewrite. The Electron + Next.js app is replaced by a Rust core and a Tauri desktop app, and runs that stop halfway now continue where they left off.

### What changes for you

- **Small, native installers.** One macOS DMG for Apple Silicon and Intel (about 14 MB, was 210 MB per architecture), a Windows installer of about 5 MB that needs no admin rights, and an AppImage and a deb for Linux. Node.js is no longer needed. Idle memory is about 230 MB, was about 560 MB.
- **Runs survive closing the app, a crash or Pause.** Every task's position is on disk. Resume continues the same subtask with the agent's own session and its partial work; finished subtasks never run again.
- **A deterministic workflow.** Planning (questions, plan, approval), one agent run per subtask with a checkpoint commit and a handoff note for the next, automated checks, then read-only QA reviewers. A failing check or QA verdict starts a rework round, shown as "Reworking (n/2)", up to two rounds.
- **Pull requests.** Checkpoints are squashed into one commit and pushed. After a rework, Human Review offers "Update pull request" and says when the PR is up to date.
- **Worktrees.** One git worktree per task, as before. A done task's worktree can be removed to free space; reopening the task brings it back.
- **Updates.** The app checks for a new stable release once at launch and asks before installing it.
- **Agents.** Claude Code, Cursor's agent CLI and Amp. Your own hooks and connectors in Claude Code do not reach task agents.
- **License:** MIT (was AGPL-3.0-or-later).

### Things to know

- 3.0 does not read task data from 2.x.
- The installers are not code-signed: macOS asks you to allow the app once in System Settings → Privacy & Security, Windows SmartScreen asks once ("More info" → "Run anyway").
- Git hooks in your repository run as git normally runs them, including on the agents' checkpoint commits and the pull request push, with your login shell's PATH.

---

## 2.2.4

### Improvements

- **Curved icon everywhere (squircle)** — The app now uses the same curved-radius icon on all platforms. `build-dock-icon.js` generates `code-automata-dock.png` and `code-automata-dock-light.png` from the main icon (~22% rounded corners and zoom). This icon is used for the macOS app bundle (Finder, dock), dock/menu bar at runtime, Windows `.ico`, Linux PNGs, and fallback; the square icon is only an intermediate build step.
- **Next.js standalone build** — `prepare-build.js` flattens nested `.next/standalone` when Next.js outputs a duplicated structure, so the packaged app always finds `server.js` in the expected location.
- **Node.js 18+ for packaged app** — Main process prefers Node 18+ (required for Next.js 15), with nvm-aware ordering (newest first) and fallback to any installed version. Resolves correct binary when multiple Node versions exist.
- **Server startup** — Startup timeout increased to 45 seconds. On failure (node not found, wrong version, or timeout), the loading screen shows clear instructions to install Node 18+, add it to PATH, and restart the app.
- **Release workflow** — Manual "Run workflow" can accept a tag (e.g. `v2.2.4`) to build and publish that release when tag push does not trigger. Note added that runs may appear 5–15 minutes after tag push.

### Build & Release

- **Icon pipeline** — Single source `public/code-automata.png`; `build-mac-icons.js` produces `code-automata-dark.png` (1024×1024); `build-dock-icon.js` produces the curved `code-automata-dock.png` used for the app icon, Windows/Linux, and dock. All builds run the dock-icon step so the curved asset exists before `build-icons.js`. `public/**/*` included in packaged app.

---

## 2.2.3

### New logo

- **App and branding** — New minimalist logo (flowchart-style icon: triangle, nodes, and arrow) used for the app icon, dock/taskbar, loading screen, and README. Single design used for both light and dark variants. Replaces previous logo assets.

### Documentation

- Documentation and doc references updated across the repo for consistency.

### New Features

- **Multi-platform builds** — Native builds for macOS (Intel & Apple Silicon), Linux (AppImage, deb, Flatpak), and Windows (NSIS, portable exe). Each platform builds on its own CI runner (no cross-compilation).
- **Git worktrees** — Complete worktree feature with sidebar integration. Per-task isolated worktrees in `.code-automata/worktrees/{taskId}` with branch `code-automata/{taskId}`.
- **3 new themes** — Additional theme options for the UI.
- **App version display** — Version number shown in the app UI.
- **Custom prompts** — Support for custom prompts with bug fixes.

### Improvements

- **Project path** — Removed home-directory restriction. Any absolute path is now accepted (e.g. `D:\repos\project` on Windows, `/mnt/projects` on Linux).
- **Open in editor** — "Open in Cursor/VS Code" now works when the project is outside the user's home directory. `projectPath` is passed so worktrees under the project root are allowed.
- **CLI adapter order** — Cursor CLI is first in the selection dropdown, followed by Amp, then Mock (dev mode only).
- **Sidebar path display** — Folder name displays correctly on Windows when paths use backslashes.
- **README restructure** — Three clear sections: Introduction, For Users (installation, platforms, assets), For Developers (build, scripts, docs). Table of contents with sub-headings.
- **DMG/ZIP optimizations** — Build output improvements for macOS disk images and archives.
- **Platform-specific icons** — Windows `.ico` and Linux PNGs generated via `build-icons.js`.
- **Broken symlinks** — `after-pack` hook removes broken symlinks in packaged `node_modules` (macOS, Linux, Windows).
- **Node resolution** — Main process resolves Node binary from platform-specific paths (nvm, Volta, fnm, Homebrew, etc.).
- **PATH augmentation** — Packaged app merges common CLI paths into `process.env.PATH` so `amp`, `agent`, `gh`, etc. are discoverable.

### Build & Release

- **GitHub Actions** — Platform-specific runners: `macos-15-intel` (x64), `macos-15` (arm64), `ubuntu-latest`, `windows-latest`.
- **Code signing** — Unset empty signing vars before build so electron-builder skips signing when secrets are not configured. See `docs/CODE_SIGNING.md` for setup.
- **Checksums** — SHA256 checksums generated and uploaded with release assets.
- **Manual trigger** — `workflow_dispatch` for dry-run builds without creating a release.
- **Changelog extraction** — Release notes pulled from this file when present.

### Bug Fixes

- **Mock adapter** — Clarified as available in dev mode only; packaged app exposes only Amp and Cursor.
- **Git worktrees sidebar** — E2E functionality fixes.
- **Modal UI** — Various fixes.
- **Documentation** — Updates to CODE_SIGNING, RELEASE, PACKAGED_APP, KANBAN_WORKFLOW, OVERVIEW.

### Documentation

- `docs/CODE_SIGNING.md` — macOS and Windows code signing setup
- `docs/RELEASE.md` — Release process and GitHub Actions
- `docs/PACKAGED_APP.md` — Packaged app considerations (PATH, Node resolution, platforms)
