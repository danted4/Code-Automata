use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{CoreError, Result};

/// Milliseconds since the Unix epoch, the timestamp unit the task files use (JavaScript `Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// UTC timestamp in the `Date.prototype.toISOString()` format, e.g. `2026-11-24T09:30:00.000Z`.
pub fn iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, process-unique number: used for temp file names and ids.
pub(crate) fn unique_u64() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Lowercase base-36 string of `len` characters. Not cryptographic; used only to make ids unlikely
/// to collide, the way `Math.random().toString(36)` did in 2.2.4.
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
    fn iso_format() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_770_141_570_210), "2026-02-03T17:59:30.210Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
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
