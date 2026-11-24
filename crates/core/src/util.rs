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
}
