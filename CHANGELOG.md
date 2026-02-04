# Changelog

All notable changes to Code-Automata are documented here.

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
