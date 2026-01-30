# QA Verification: New Task Modal and Theme Check

**Subtask:** Manual modal and theme check  
**Date:** 2026-01-31  
**Scope:** New task modal open behavior, tool select area, readiness block, loader theme colors, and CLI tool switching (amp / cursor / mock).

---

## 1. No visible flicker or sudden height change when modal opens

### Code findings

- **Dialog open animation:** `DialogContent` uses Radix with `duration-200`, `zoom-in-95`, and `slide-in-from-*`. The modal animates in; that is intentional and not a content flicker.
- **Content height:** The modal body has no fixed height. Height is driven by:
  - Fixed/stable: header, task name, description, tool row (see §2), readiness block (see §3), footer.
  - Variable: **CLI Configuration** block is conditionally rendered with `{configSchema && configSchema.fields.length > 0 && (...)}`. It appears only after adapters load and when the selected adapter has config fields. When it appears, the modal **grows**.
- **Initial render:** On open, `isLoadingAdapters === true`, so the tool row shows the reserved-height loader and the readiness block shows "Checking…". No content is missing that would cause a visible "pop-in" for those two areas.

### Risk

- **Modal growth after open:** When `/api/cli/adapters` resolves and the selected adapter (e.g. amp) has `configSchema.fields`, the "CLI Configuration" section is mounted and the modal height increases. This is a **single growth event** after load, not a flicker, but it is a **sudden height change** after the modal has opened.

### Manual check

1. Open the new task modal (e.g. from sidebar).
2. Confirm: no visible flicker during the open animation.
3. Confirm: tool row and readiness block do not jump when switching from loader to dropdown/content.
4. Note: modal may grow once when CLI Configuration appears; per requirement this may be considered a failure if "no sudden height change" is strict.

**Verdict:** **Pass with caveat** — No flicker from tool/readiness; possible **failure** if the requirement forbids any post-open growth (due to CLI Configuration appearing).

---

## 2. Tool select area: reserved-height loader, then dropdown without modal growth

### Code findings

- **Reserved height:** The loader placeholder is a `div` with `h-10 w-full` and the same border/surface styling as the select. The `SelectTrigger` also uses `h-10` (see `select.tsx`). So the **tool row height is constant** (h-10) when switching from loader to dropdown.
- **No extra growth from tool row:** Replacing the loader with the Select does not change the height of the modal; both states use the same height.

### Risk

- None identified for the tool row itself. Any modal growth is from the CLI Configuration block (§1), not from the tool select area.

### Manual check

1. Open the new task modal.
2. Confirm: the CLI tool row shows a centered spinner in a control-sized row (same height as the dropdown).
3. After adapters load, confirm: the row becomes the dropdown without the row or modal getting taller.

**Verdict:** **Pass** — Tool select area has reserved height and swaps loader → dropdown without modal growth from this row.

---

## 3. Readiness block always present, min-height, loader then correct content

### Code findings

- **Always present:** The readiness block is a single `div` with `min-h-[88px]` and is always rendered (no conditional wrapper).
- **Min-height:** `min-h-[88px]` is set; content can be taller.
- **Loader state:** When `isLoadingAdapters || (cliTool === 'amp' && isCheckingAmp) || (cliTool === 'cursor' && isCheckingCursor)`, the block shows "Checking…" with a spinner.
- **Content states:** After load:
  - `amp` → Amp readiness (status, CLI path, auth, optional fix steps).
  - `cursor` → Cursor readiness (same shape).
  - `mock` (or other) → "No readiness check for this tool."

So the block is always there, has a minimum height, and shows loader then the correct content.

### Risk

- **Content height varies:** For amp/cursor, content can be long (e.g. many fix steps). The block uses `min-h-[88px]`, not a fixed height, so the **readiness block itself** can grow/shrink with content. That does not contradict "always present" or "min-height" but can contribute to layout shift when switching tools (§5).

### Manual check

1. Open the new task modal.
2. Confirm: the readiness block is always visible with at least the same minimum height (e.g. one line + padding).
3. Confirm: it first shows "Checking…" with spinner, then switches to the correct content (amp / cursor / mock) without the block disappearing or collapsing.

**Verdict:** **Pass** — Readiness block is always present, has min-height, and shows loader then correct content.

---

## 4. Loaders use theme colors (var(--color-info)) in dark / light / retro

### Code findings

- **New task modal loaders:**
  - Tool select loader: `style={{ color: 'var(--color-info)' }}` on `Loader2`.
  - Readiness "Checking…" loader: `style={{ color: 'var(--color-info)' }}` on `Loader2`.
- **Theme variables:** `ThemeProvider` sets `--color-info` from `theme.colors.info` in `useEffect`. `theme-config.ts` defines:
  - **dark:** `info: '#06b6d4'`
  - **light:** `info: '#0891b2'`
  - **retro:** `info: '#00ffff'`
- **Fallback:** `globals.css` `:root` sets `--color-info: #06b6d4` so there is a value before the theme effect runs.

Loaders consistently use `var(--color-info)` and all three themes define `info`; the provider applies it to the document root.

### Risk

- **Hydration/SSR:** If the modal is rendered server-side or before the theme effect runs, the first paint uses the `:root` fallback (dark info color). After hydration and theme effect, it updates to the active theme. In normal client-side usage this should be a quick transition; only a flash would be a concern.

### Manual check

1. Set theme to **dark** → open new task modal → confirm loaders are cyan/info-colored.
2. Set theme to **light** → open modal → confirm loaders match light theme info color.
3. Set theme to **retro** → open modal → confirm loaders use retro info (e.g. bright cyan).
4. Switch theme with modal open and confirm loader color updates.

**Verdict:** **Pass** — Loaders use `var(--color-info)` and dark/light/retro all define and apply it.

---

## 5. Switching between amp, cursor, and mock causes no layout jump or flicker

### Code findings

- **Tool switch:** `handleCliChange` updates `cliTool` and resets `cliConfig` from the new adapter’s schema. No layout-specific logic.
- **Readiness block:** Same container with `min-h-[88px]`. Content switches between:
  - Amp: title + status + optional CLI/Auth lines + optional fix steps list.
  - Cursor: same structure.
  - Mock: single line "No readiness check for this tool."
- **Height:** Only `min-h-[88px]` is set; height is not fixed. So when switching:
  - **mock → amp/cursor:** Content can go from one short line to multiple lines (e.g. fix steps) → **readiness block can grow** → layout shift.
  - **amp/cursor → mock:** Block can shrink → layout shift.
  - **amp ↔ cursor:** Both can have variable length (e.g. different instruction counts) → possible small shift.
- **CLI Configuration:** When switching adapters, `configSchema` and thus the "CLI Configuration" section can appear or disappear (e.g. mock may have no fields, amp/cursor may have some). That section is below the readiness block, so it can **add or remove a whole block** and cause a clear layout jump.

### Risk

- **Readiness block:** Variable content height within a min-height container causes **layout jump** when switching tools.
- **CLI Configuration:** Section mount/unmount when switching between adapters with and without config fields causes **layout jump**.

So with the current implementation, **layout jump or visible shift when switching amp/cursor/mock is expected** in those cases.

### Manual check

1. Open the new task modal and wait for adapters and readiness to load.
2. Switch CLI tool: **mock → amp** → observe readiness block and optional CLI Configuration; note any vertical jump.
3. Switch **amp → cursor** → same.
4. Switch **cursor → mock** → note readiness and possible disappearance of CLI Configuration.
5. Repeat in dark, light, and retro to ensure no theme-specific flicker.

**Verdict:** **Failure** — Switching between amp, cursor, and mock can cause layout jump or flicker due to (a) variable readiness content height and (b) CLI Configuration section appearing/disappearing.

---

## Summary

| # | Requirement | Verdict | Notes |
|---|-------------|--------|--------|
| 1 | No flicker/sudden height change on open | Pass with caveat | Possible failure if strict: CLI Configuration appears after load and increases modal height. |
| 2 | Tool select: reserved-height loader, then dropdown, no growth | Pass | h-10 for both states; no growth from this row. |
| 3 | Readiness block always present, min-height, loader → content | Pass | min-h-[88px], always rendered, correct loading and content states. |
| 4 | Loaders use var(--color-info) in dark/light/retro | Pass | Both loaders use it; themes and provider set it. |
| 5 | No layout jump/flicker when switching amp/cursor/mock | **Failure** | Readiness content height varies; CLI Configuration section can mount/unmount. |

**Reported failures (no code changes):**

1. **§1 (optional):** Modal can have a single sudden height change when the CLI Configuration section appears after adapters load.
2. **§5:** Switching between amp, cursor, and mock can cause layout jump or flicker due to variable readiness block height and CLI Configuration appearing/disappearing.

---

## Manual verification steps (concise)

1. **Open:** Open new task modal → no flicker; note any height change when "CLI Configuration" appears.
2. **Tool row:** Confirm loader then dropdown in same-height row; no growth from this row.
3. **Readiness:** Confirm block always visible with min-height, "Checking…" then correct content.
4. **Themes:** In dark, light, retro confirm loaders use theme info color; switch theme with modal open.
5. **Switching tools:** Switch mock ↔ amp ↔ cursor and observe readiness block and CLI Configuration for layout jump or flicker.

---

## Build, Lint, and E2E Verification (QA Subtask)

**Subtask:** Build, lint, and e2e verification  
**Date:** 2026-01-31  
**Scope:** Run `yarn build`, `yarn lint`, and e2e tests that open the new task modal; optionally add e2e assertions for tool select and readiness areas.

### Commands to run (manual)

Run these in the project root. Terminal execution was not available in the verification environment.

```bash
# 1. Build – verify no build errors
yarn build
# Or Next.js only: yarn next:build

# 2. Lint – fix only pre-existing issues
yarn lint
# Auto-fix: yarn lint:fix

# 3. E2E – tests that open the new task modal
yarn test:e2e e2e/kanban.spec.ts e2e/theme-visual-test.spec.ts e2e/theme-audit.spec.ts
```

Playwright will start the dev server via `webServer` in `playwright.config.ts` if not already running.

### What was done (no implementation logic changed)

1. **Lint (static):** `read_lints` on `src/` reported **no linter errors**. No fixes applied.
2. **E2E assertions added (optional):**
   - **New task modal test IDs** in `new-task-modal.tsx`:
     - `data-testid="new-task-modal-tool-select-area"` on the CLI Tool selection wrapper.
     - `data-testid="new-task-modal-readiness-area"` on the tool readiness container.
   - **Kanban spec** (`e2e/kanban.spec.ts`): New test **"should show new task modal with tool select and readiness areas"** — clicks New Task, asserts dialog visible, tool select area visible and contains "CLI Tool", readiness area visible and contains one of "Amp readiness" / "Cursor readiness" / "No readiness check for this tool" / "Checking…", then closes with Escape.
   - **Theme visual test** (`e2e/theme-visual-test.spec.ts`): After opening the new task modal, asserts `new-task-modal-tool-select-area` and `new-task-modal-readiness-area` are visible before taking the screenshot.
3. **Pre-existing e2e bug fixed:** In `theme-audit.spec.ts`, Test 6 previously used `page.click('[id="cli-tool"]')` to "click theme selector". The `#cli-tool` id belongs to the **New Task modal’s CLI tool select**, not the theme switcher. After closing the modal, that selector is wrong. Fixed to use the theme switcher: `page.locator('text=Modern Dark').first()` before opening the theme dropdown, consistent with Test 7.

### Build / lint / e2e status (to be confirmed by you)

- **Build:** Not run in this environment. Run `yarn build` (or `yarn next:build`) and fix any reported errors.
- **Lint:** No linter errors reported for `src/`. Run `yarn lint` and fix any pre-existing issues only.
- **E2E:** Not run in this environment. Run the three specs above; report any failures **without changing implementation logic** (only test or test-infra fixes are acceptable per task).

### Failure reporting

If any of the following fail, report them and do **not** change app implementation logic:

- **Build:** Compile or Next/Electron build errors.
- **Lint:** ESLint errors or warnings (fix only if pre-existing).
- **E2E:** Failures in `kanban.spec.ts`, `theme-visual-test.spec.ts`, or `theme-audit.spec.ts` (e.g. selectors, timing, or missing elements).
