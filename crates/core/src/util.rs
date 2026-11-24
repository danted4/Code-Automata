use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{CoreError, Result};

/// Milliseconds since the Unix epoch, the timestamp unit of task files.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, process-unique number: used for temp file names and ids.
pub(crate) fn unique_u64() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Lowercase base-36 string of `len` characters. Not cryptographic; only makes ids unlikely to collide.
pub(crate) fn random_base36(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(unique_u64());
        hasher.write_i64(now_ms());
        let mut n = hasher.finish();
        while n > 0 && out.len() < len {
            out.push(char::from(ALPHABET[(n % 36) as usize]));
            n /= 36;
        }
    }
    out
}

/// A random version-4 UUID string, for session ids the caller chooses (Claude's `--session-id`).
pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(unique_u64());
        hasher.write_i64(now_ms());
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Task ids become file and directory names, so they are restricted to a safe alphabet.
pub fn validate_task_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(CoreError::InvalidTaskId(id.to_string()))
    }
}

/// `canonicalize`, giving the everyday path form on Windows (see [`plain_path`]).
pub async fn canonicalize(
    path: impl AsRef<std::path::Path>,
) -> std::io::Result<std::path::PathBuf> {
    tokio::fs::canonicalize(path).await.map(plain_path)
}

/// Windows `canonicalize` returns verbatim paths (`\\?\C:\repo`, `\\?\UNC\server\share`). Give back
/// the everyday form (`C:\repo`, `\\server\share`), which git and every other tool accept and
/// which compares equal to paths built from git's output. A verbatim path with no plain equivalent
/// (`\\?\Volume{…}`, or one whose meaning the plain form would change) is returned unchanged.
/// Other paths, including every Unix path, are returned unchanged.
///
/// Ported from torrenter (`src/paths.rs`).
pub fn plain_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        if plain_keeps_meaning(rest) {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        return path;
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if drive && (bytes.len() == 2 || bytes[2] == b'\\') && plain_keeps_meaning(&rest[2..]) {
            return std::path::PathBuf::from(rest);
        }
    }
    path
}

/// Without `\\?\` Windows trims a trailing dot or space from each component and treats device
/// names (CON, NUL, COM1, …) specially, so such a path would point elsewhere: keep those verbatim.
fn plain_keeps_meaning(rest: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    rest.split('\\')
        .filter(|part| !part.is_empty())
        .all(|part| {
            if part.ends_with('.') || part.ends_with(' ') {
                return false;
            }
            let stem = part.split('.').next().unwrap_or(part).trim_end();
            let upper = stem.to_ascii_uppercase();
            let numbered = (upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit()
                && upper.as_bytes()[3] != b'0';
            !(RESERVED.contains(&upper.as_str()) || numbered)
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn task_ids() {
        assert!(validate_task_id("task-1770141570210-arvol").is_ok());
        assert!(validate_task_id("a_b-C9").is_ok());
        for bad in [
            "",
            "../x",
            "a/b",
            ".hidden",
            "a b",
            "a.json",
            &"x".repeat(129),
        ] {
            assert!(validate_task_id(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn uuid_shape() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(uuid_v4(), uuid_v4());
    }

    #[test]
    fn base36_shape() {
        let s = random_base36(5);
        assert_eq!(s.len(), 5);
        assert!(
            s.bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        );
        assert_ne!(random_base36(12), random_base36(12));
    }

    #[test]
    fn verbatim_windows_paths_become_plain() {
        use std::path::PathBuf;
        let plain = |text: &str| plain_path(PathBuf::from(text)).display().to_string();
        assert_eq!(plain(r"\\?\E:\my\folder"), r"E:\my\folder");
        assert_eq!(plain(r"\\?\C:\"), r"C:\");
        assert_eq!(plain(r"\\?\UNC\nas\share\dl"), r"\\nas\share\dl");
        // Plain would mean another folder: a trailing dot or space, a device name.
        assert_eq!(plain(r"\\?\E:\dl.\x"), r"\\?\E:\dl.\x");
        assert_eq!(plain(r"\\?\E:\dl \x"), r"\\?\E:\dl \x");
        assert_eq!(plain(r"\\?\E:\con\x"), r"\\?\E:\con\x");
        assert_eq!(plain(r"\\?\E:\aux.txt"), r"\\?\E:\aux.txt");
        assert_eq!(plain(r"\\?\E:\COM1"), r"\\?\E:\COM1");
        assert_eq!(plain(r"\\?\UNC\nas\share\nul"), r"\\?\UNC\nas\share\nul");
        // Look-alikes that are ordinary names stay plain.
        assert_eq!(
            plain(r"\\?\E:\console\COM0\com12"),
            r"E:\console\COM0\com12"
        );
        // No plain equivalent, or already plain: unchanged.
        assert_eq!(plain(r"\\?\Volume{abc}\dl"), r"\\?\Volume{abc}\dl");
        assert_eq!(plain(r"E:\my\folder"), r"E:\my\folder");
        assert_eq!(plain("/home/me/repo"), "/home/me/repo");
    }
}
