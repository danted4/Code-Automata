//! Which CLIs are rate-limited, shared by every open project.
//!
//! A subscription's usage limit belongs to the account, not to one task: once a run of a CLI hits
//! it, the next run of that CLI anywhere would hit it too. The engine records the limit here, and
//! a task about to run that CLI waits (its run becomes `rate_limited`) instead of starting and
//! failing. The record lives only in memory; each rate-limited run carries its own reset time in
//! the task file, which is how the limit is learnt again after a restart.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::task::Provider;

/// A CLI's limit: until when (seconds since the epoch), and whether that is a guess because the
/// CLI did not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit {
    pub until: i64,
    pub estimated: bool,
}

#[derive(Debug, Default)]
pub struct RateLimits {
    limits: Mutex<HashMap<Provider, Limit>>,
}

impl RateLimits {
    /// The CLI's limit, if it has not reset by `now` (seconds since the epoch).
    pub fn active(&self, provider: Provider, now: i64) -> Option<Limit> {
        self.lock()
            .get(&provider)
            .copied()
            .filter(|l| l.until > now)
    }

    /// Record a limit; an existing later one is kept.
    pub fn record(&self, provider: Provider, limit: Limit) {
        let mut limits = self.lock();
        match limits.get(&provider) {
            Some(existing) if existing.until >= limit.until => {}
            _ => {
                limits.insert(provider, limit);
            }
        }
    }

    /// Forget the CLI's limit (the user chose "Resume now").
    pub fn clear(&self, provider: Provider) {
        self.lock().remove(&provider);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Provider, Limit>> {
        self.limits.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// How rate-limited runs are woken. Tests shorten these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WakeTiming {
    /// Waited after the reset time before resuming, so the CLI's own clock has certainly passed it.
    pub grace: Duration,
    /// When the CLI gave no reset time: how long until the next try.
    pub unknown_reset_wait: Duration,
    /// How often a waiting run checks the clock. One long sleep would fire late after the
    /// computer sleeps (the runtime's clock stops), so the wall clock is checked at this interval.
    pub tick: Duration,
}

impl Default for WakeTiming {
    fn default() -> Self {
        WakeTiming {
            grace: Duration::from_secs(60),
            unknown_reset_wait: Duration::from_secs(30 * 60),
            tick: Duration::from_secs(60),
        }
    }
}

/// Seconds since the epoch.
pub fn now_secs() -> i64 {
    crate::util::now_ms() / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_limit_is_active_until_it_resets_and_the_later_one_wins() {
        let limits = RateLimits::default();
        assert_eq!(limits.active(Provider::Claude, 100), None);
        limits.record(
            Provider::Claude,
            Limit {
                until: 200,
                estimated: false,
            },
        );
        limits.record(
            Provider::Claude,
            Limit {
                until: 150,
                estimated: true,
            },
        );
        assert_eq!(
            limits.active(Provider::Claude, 100),
            Some(Limit {
                until: 200,
                estimated: false
            })
        );
        assert_eq!(limits.active(Provider::Claude, 200), None);
        assert_eq!(limits.active(Provider::Cursor, 100), None);
        limits.clear(Provider::Claude);
        assert_eq!(limits.active(Provider::Claude, 100), None);
    }
}
