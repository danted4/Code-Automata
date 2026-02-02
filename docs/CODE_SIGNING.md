# macOS Code Signing & Notarization

To eliminate the `xattr -cr` workaround for users downloading Code-Auto from GitHub releases, you need to **code sign and notarize** the app with an Apple Developer account.

## Prerequisites

- **Apple Developer account** ($99/year) — [developer.apple.com](https://developer.apple.com)
- **Developer ID Application** certificate in your keychain
- **App-specific password** for your Apple ID — [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords

## Setup

### 1. Create Developer ID certificate

1. In [Apple Developer Portal](https://developer.apple.com/account/resources/certificates/list) → Certificates → create **Developer ID Application**
2. Download and double-click to install in Keychain Access
3. Export as `.p12` (File → Export Items) with a password

### 2. Set environment variables

For **local builds**:

```bash
export CSC_LINK="$HOME/path/to/your-certificate.p12"
export CSC_KEY_PASSWORD="your-p12-password"
export APPLE_ID="your-apple-id@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

Or use a `.env` file (add to `.gitignore`):

```
CSC_LINK=/path/to/certificate.p12
CSC_KEY_PASSWORD=your-password
APPLE_ID=your-apple-id@email.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=YOUR_TEAM_ID
```

**Find your Team ID:** [developer.apple.com/account](https://developer.apple.com/account) → Membership details

### 3. Build

```bash
yarn build
```

With credentials set, electron-builder will:

1. Sign the app with your Developer ID
2. Notarize it with Apple
3. Produce a DMG that opens without `xattr -cr`

### 4. GitHub Actions (CI)

Add these as **repository secrets** for automated releases:

| Secret                        | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `CSC_LINK`                    | Base64-encoded .p12: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD`            | P12 password                                        |
| `APPLE_ID`                    | Apple ID email                                      |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password                               |
| `APPLE_TEAM_ID`               | Team ID                                             |

**Note:** The release workflow unsets empty signing env vars and sets `CSC_IDENTITY_AUTO_DISCOVERY: false` so macOS builds succeed without Apple Developer secrets. When you add the secrets above, signing should work. If signing is skipped despite having secrets, you may need to adjust the workflow's build step.

Then update `.github/workflows/release.yml` to pass them:

```yaml
env:
  CSC_LINK: ${{ secrets.CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

## Without code signing

**macOS:** Builds use ad-hoc signing. Users must run:

```bash
xattr -cr /Applications/Code-Auto.app
```

**Windows:** SmartScreen may block unsigned `.exe` files. Users must click **More info** → **Run anyway** when opening the installer or portable exe.

Document these workarounds in your release notes.
