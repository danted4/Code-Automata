# Packaged App Considerations

This document describes differences between running Code-Auto via `yarn start` (development) vs. the packaged DMG/app (production), and how we handle them.

## Architecture: Next.js Standalone + Electron

The packaged app uses **Next.js standalone output**:

1. **Build**: `next build` produces `.next/standalone/` with a minimal traced server and `node_modules`
2. **Copy**: `public` and `.next/static` are copied into the standalone folder (required for static assets)
3. **Package**: electron-builder packs `.next/standalone/**/*` into the app
4. **Runtime**: Electron spawns `node server.js` as a subprocess from `app.asar.unpacked/.next/standalone/`
5. **afterPack**: electron-builder excludes nested `node_modules`; `scripts/after-pack.js` copies it into the packaged app

**Node.js requirement**: The packaged app requires Node.js to be installed (Homebrew, nvm, Volta, or fnm). The main process resolves the Node binary from common paths before spawning the server.

## Why Packaged Apps Behave Differently

When launched from the DMG (or as a GUI app), macOS gives the app a **minimal environment**:

- **PATH** — Only `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`. User-installed tools (`agent`, `amp`, `gh`, `cursor`, `code`) are typically in `~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin` — none of which are in the default GUI PATH.
- **Environment variables** — No `.bashrc`/`.zshrc`. `CURSOR_API_KEY`, `AMP_API_KEY`, and similar vars set in the shell are **not** inherited.
- **Working directory** — `process.cwd()` may be the app bundle or launch context, not the user's project.

## Mitigations in `electron/main.js`

### 1. Environment Enhancement (`enhanceEnvForPackagedApp`)

Runs at startup when `app.isPackaged` is true:

- **macOS/Linux** — Runs the user's login shell (`$SHELL -l -c 'echo $PATH'`) and merges it into `process.env.PATH`. Fallback: adds `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` if they exist.
- **Windows** — Merges common paths (`%APPDATA%\\npm`, `%LOCALAPPDATA%\\Programs`, `%ProgramFiles%\\nodejs`) into `process.env.PATH`.
- **CURSOR_API_KEY** / **AMP_API_KEY** — On macOS/Linux, loaded from the user's shell if not set.

This ensures `which agent`, `which amp`, `which gh`, etc. work, and API keys are available.

### 2. Node Binary Resolution (`resolveNodeBinary`)

When spawning the Next.js server, the main process resolves the Node binary from platform-specific paths:

- **macOS** — `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.nvm`, `~/.volta`, `~/.fnm`
- **Linux** — `/usr/bin/node`, `/usr/local/bin/node`, `~/.nvm`, `~/.volta`, `~/.fnm`
- **Windows** — `%ProgramFiles%\\nodejs\\node.exe`, `%LOCALAPPDATA%\\Programs\\node\\node.exe`, `~/.volta`, `~/.fnm`, `%APPDATA%\\nvm`
- Fallback: `which node` (or `where node` on Windows)

### 3. Base URL (`NEXT_PUBLIC_APP_URL`)

The server may run on port 3001, 3002, etc. if 3000 is busy. API routes that call back to the app (e.g. `start-planning` → `start-development`) use `NEXT_PUBLIC_APP_URL`. We set `process.env.NEXT_PUBLIC_APP_URL = url` before starting the Next.js server so callbacks hit the correct port.

### 4. Packaged Detection (`CODE_AUTO_PACKAGED`)

The spawn env includes `CODE_AUTO_PACKAGED=1`. API routes (e.g. `/api/cli/adapters`) use this to hide the Mock CLI in the packaged app, since the Next.js server runs in a Node subprocess (not Electron) and `process.versions.electron` is undefined.

### 5. Project Path

Project path comes from the user via the Open Project modal and is sent as `X-Project-Path`. API routes use this; they do **not** rely on `process.cwd()` for the project root. The `process.cwd()` fallback in `getProjectDir` is only used when no path is provided — in that case, behavior may differ in packaged vs. dev.

## Checklist for New Features

When adding features that might run in the packaged app, consider:

| Concern                       | Dev                  | Packaged              | Mitigation                                    |
| ----------------------------- | -------------------- | --------------------- | --------------------------------------------- |
| **PATH** (CLI tools)          | Inherits shell PATH  | Minimal PATH          | `enhanceEnvForPackagedApp`                    |
| **CURSOR_API_KEY**            | From shell           | Not set               | `enhanceEnvForPackagedApp`                    |
| **AMP_API_KEY**               | From shell           | Not set               | `enhanceEnvForPackagedApp`                    |
| **Base URL** (internal fetch) | localhost:3000       | May be 3001, etc.     | Set `NEXT_PUBLIC_APP_URL` before server start |
| **Project path**              | From X-Project-Path  | Same                  | User selects via modal                        |
| **process.cwd()**             | Project root (often) | App bundle or other   | Prefer X-Project-Path                         |
| **HOME / USERPROFILE**        | Set by shell         | Usually set by system | Rarely an issue                               |

### Things That Use PATH

- `which agent` — Cursor preflight
- `which amp` — Amp preflight (also augments PATH in `getExecEnv()` when running in Electron, so `amp whoami` and config reads work)
- `spawn('agent', ...)` — CursorAdapter
- `spawn('amp', ...)` — AmpAdapter
- `execSync('which cursor')`, `execSync('which code')` — Editor detection (Review Locally)
- `execFile('gh', ...)` — Create MR
- `execSync('git ...')` — WorktreeManager, project validate (git is usually in `/usr/bin`)

### Things That Use Env Vars

- `CURSOR_API_KEY` — Cursor auth
- `AMP_API_KEY` — Amp auth
- `NEXT_PUBLIC_APP_URL` — Internal API callbacks
- `HOME` / `USERPROFILE` — Path validation in `getProjectDir`

## Apple Silicon (M1/M2/M3) cross-compilation

On Apple Silicon, `yarn build:all` fails with "bad CPU type in executable" because electron-builder's Linux (AppImage) and Windows tools (mksquashfs, Wine) are x86_64-only. Use `yarn build:mac` for local macOS builds, `yarn build:all:rosetta` to attempt full build under Rosetta 2, or GitHub Actions for releases.

## Build Process

```
yarn build
  → rm -rf dist-electron
  → yarn next:build          # Produces .next/standalone, .next/static
  → cp -r public .next/standalone/
  → cp -r .next/static .next/standalone/.next/
  → electron-builder         # Packs .next/standalone, runs afterPack
```

**afterPack** (`scripts/after-pack.js`): Copies `.next/standalone/node_modules` into the packaged app because electron-builder excludes nested node_modules.

## Testing Packaged Build

1. Ensure Node.js is installed (Homebrew, nvm, Volta, or fnm)
2. Build: `yarn build`
3. Run the DMG from `dist-electron/`
4. Open a project and verify:
   - Cursor/Amp readiness shows correctly (Mock is hidden in packaged app)
   - Creating a task and starting development works
   - Review Locally (open in Cursor/VS Code, open folder) works
   - Create MR works (if `gh` is installed)

## Adding New Env Vars or CLI Tools

- **New env var** — Add it to the `envVars` array in `enhanceEnvForPackagedApp` if it should come from the user's shell.
- **New CLI tool** — If it's on the user's PATH when run from a terminal, the PATH enhancement should make it available. If it lives in a non-standard location, consider adding that path to the fallback list.
