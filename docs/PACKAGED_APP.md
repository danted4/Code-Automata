# Packaged App Considerations

This document describes differences between running Code-Auto via `yarn start` (development) vs. the packaged DMG/app (production), and how we handle them.

## Why Packaged Apps Behave Differently

When launched from the DMG (or as a GUI app), macOS gives the app a **minimal environment**:

- **PATH** — Only `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`. User-installed tools (`agent`, `amp`, `gh`, `cursor`, `code`) are typically in `~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin` — none of which are in the default GUI PATH.
- **Environment variables** — No `.bashrc`/`.zshrc`. `CURSOR_API_KEY`, `AMP_API_KEY`, and similar vars set in the shell are **not** inherited.
- **Working directory** — `process.cwd()` may be the app bundle or launch context, not the user's project.

## Mitigations in `electron/main.js`

### 1. Environment Enhancement (`enhanceEnvForPackagedApp`)

Runs at startup when `app.isPackaged` is true:

- **PATH** — Runs the user's login shell (`$SHELL -l -c 'echo $PATH'`) and merges it into `process.env.PATH`. Fallback: adds `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin` if they exist.
- **CURSOR_API_KEY** — Loaded from the user's shell if not set.
- **AMP_API_KEY** — Same as above.

This ensures `which agent`, `which amp`, `which gh`, etc. work, and API keys are available.

### 2. Base URL (`NEXT_PUBLIC_APP_URL`)

The server may run on port 3001, 3002, etc. if 3000 is busy. API routes that call back to the app (e.g. `start-planning` → `start-development`) use `NEXT_PUBLIC_APP_URL`. We set `process.env.NEXT_PUBLIC_APP_URL = url` before starting the Next.js server so callbacks hit the correct port.

### 3. Project Path

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

## Testing Packaged Build

1. Build: `yarn build`
2. Run the DMG from `dist-electron/`
3. Open a project and verify:
   - Cursor/Amp readiness shows correctly
   - Creating a task and starting development works
   - Review Locally (open in Cursor/VS Code, open folder) works
   - Create MR works (if `gh` is installed)

## Adding New Env Vars or CLI Tools

- **New env var** — Add it to the `envVars` array in `enhanceEnvForPackagedApp` if it should come from the user's shell.
- **New CLI tool** — If it's on the user's PATH when run from a terminal, the PATH enhancement should make it available. If it lives in a non-standard location, consider adding that path to the fallback list.
