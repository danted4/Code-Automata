# Release Process

## Recommended: GitHub Actions (no corruption)

The most reliable way to publish releases is via GitHub Actions:

1. **Tag and push:**

   ```bash
   git tag v2.2.0
   git push origin v2.2.0
   ```

2. The [.github/workflows/release.yml](../.github/workflows/release.yml) workflow will:
   - Build on platform-specific runners (no cross-compilation): Intel macOS (`macos-15-intel`), Apple Silicon macOS (`macos-15`), Linux (`ubuntu-latest`), Windows (`windows-latest`)
   - Create the release with all assets (DMG for Intel + ARM64, ZIP, AppImage, deb, Flatpak, exe)
   - Generate SHA256 checksums for all assets
   - Extract release notes from `CHANGELOG.md` when present (looks for `## X.Y.Z` section)

Assets are built and uploaded from GitHub's infrastructure, avoiding local upload issues.

**Manual trigger:** Go to Actions → Release → Run workflow to test the build pipeline without creating a release (dry run).

**Release notes:** Add a `CHANGELOG.md` with sections like `## 2.2.0` or `## 2.2.0 - Title`; the workflow extracts that section as the release body.

**Code signing (optional):** To avoid the `xattr -cr` workaround for users, add Apple Developer secrets and see [docs/CODE_SIGNING.md](CODE_SIGNING.md).

## Apple Silicon (M1/M2/M3) local builds

On Apple Silicon, `yarn build:all` fails with "bad CPU type in executable" because electron-builder's Linux (AppImage) and Windows tools (mksquashfs, Wine) are x86_64-only and don't run natively on arm64.

**Options:**

1. **GitHub Actions (recommended)** — Push a tag; each platform builds natively on its runner (macOS, Ubuntu, Windows).
2. **`yarn build:all:rosetta`** — Runs the full build under Rosetta 2 (x86_64 emulation). Requires Rosetta installed (`softwareupdate --install-rosetta`).
3. **`yarn build:mac`** — Build macOS only locally; use CI for Linux and Windows.

## Manual upload (gh release upload)

If you must upload manually, `gh release upload` can corrupt large binary files (DMG/ZIP) due to multipart encoding. Symptoms:

- Downloaded file size differs from local (e.g. 190 MB → 181 MB)
- "Package is corrupted" when opening the DMG

**Cause:** `gh release upload` uses `multipart/form-data`, which can mangle binary files. GitHub stores the multipart wrapper instead of the raw file, causing truncation and corruption.

**Workarounds:**

1. **Use GitHub Actions** (recommended) — push a tag and let the workflow handle it.

2. **Upload via curl** with raw binary (avoids multipart corruption):

   ```bash
   # Create release first: gh release create v2.2.0 --generate-notes
   # Get upload URL: gh release view v2.2.0 --json uploadUrl -q '.uploadUrl'
   # Replace {?name,label} with ?name=FILENAME and POST with Content-Type: application/octet-stream
   ```

3. **Distribute ZIP instead of DMG** — ZIP often survives upload better; users can extract and run the .app.

4. **Verify checksums** — Before upload, run `shasum -a 256 dist-electron/*.dmg`. After download, verify the hash matches. If it doesn't, the upload corrupted the file.

5. **Replacing corrupted assets** — If you already uploaded a corrupted file, delete it first:
   ```bash
   gh release delete-asset v2.2.0 Code-Auto-2.2.0-arm64.dmg
   ```
   Then re-upload via GitHub Actions (delete release, re-tag, push) or curl with raw binary.
