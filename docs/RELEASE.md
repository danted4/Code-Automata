# Release Process

## Recommended: GitHub Actions (no corruption)

The most reliable way to publish releases is via GitHub Actions:

1. **Tag and push:**

   ```bash
   git tag v2.2.0
   git push origin v2.2.0
   ```

2. The [.github/workflows/release.yml](../.github/workflows/release.yml) workflow will:
   - Build the app on macOS
   - Create the release
   - Upload DMG and ZIP assets

Assets are built and uploaded from GitHub's infrastructure, avoiding local upload issues.

**Code signing (optional):** To avoid the `xattr -cr` workaround for users, add Apple Developer secrets and see [docs/CODE_SIGNING.md](CODE_SIGNING.md).

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
