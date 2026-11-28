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

pub use crate::agent::limits::LimitScope;
use crate::task::{AgentConfig, Provider};

/// A CLI's limit: until when (seconds since the epoch), and whether that is a guess because the
/// CLI did not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit {
    pub until: i64,
    pub estimated: bool,
}

/// What a recorded limit holds back: a CLI's whole account (`None`), or one model family on it.
type Key = (Provider, Option<String>);

#[derive(Debug, Default)]
pub struct RateLimits {
    limits: Mutex<HashMap<Key, Limit>>,
}

/// The model family a run of `agent` uses, for limits that hold back one model: "opus", "sonnet",
/// "fable" or "haiku" for Claude Code (from the model id or alias), the model id for the others,
/// and "default" when the task names none.
pub fn model_family(agent: &AgentConfig) -> String {
    let model = agent.model.as_deref().map(str::to_lowercase);
    match (agent.provider, model) {
        // The mock agent speaks Claude Code's stream, limits included.
        (Provider::Claude | Provider::Mock, Some(m)) => ["opus", "sonnet", "fable", "haiku"]
            .iter()
            .find(|f| m.contains(*f))
            .map_or_else(|| "default".to_string(), |f| (*f).to_string()),
        (_, Some(m)) if !m.trim().is_empty() => m,
        _ => "default".to_string(),
    }
}

/// The scope a run's limit is recorded with: a model limit that did not say which model is the
/// run's own.
pub fn resolve(scope: LimitScope, agent: &AgentConfig) -> LimitScope {
    match scope {
        LimitScope::Model(None) => LimitScope::Model(Some(model_family(agent))),
        other => other,
    }
}

impl RateLimits {
    /// The limit holding back a run of `agent` at `now` (seconds since the epoch): its CLI's
    /// account limit or its model's, whichever lasts longer.
    pub fn active(&self, agent: &AgentConfig, now: i64) -> Option<Limit> {
        self.holding(agent, now).map(|(limit, _)| limit)
    }

    /// [`RateLimits::active`], with the scope it was recorded under.
    pub fn holding(&self, agent: &AgentConfig, now: i64) -> Option<(Limit, LimitScope)> {
        let limits = self.lock();
        let family = model_family(agent);
        [
            ((agent.provider, None), LimitScope::Account),
            (
                (agent.provider, Some(family.clone())),
                LimitScope::Model(Some(family)),
            ),
        ]
        .into_iter()
        .filter_map(|(k, scope)| limits.get(&k).map(|l| (*l, scope)))
        .filter(|(l, _)| l.until > now)
        .max_by_key(|(l, _)| l.until)
    }

    /// Record a limit for the others it holds back (a `Run` scope holds back nobody); an existing
    /// later one is kept.
    pub fn record(&self, provider: Provider, scope: &LimitScope, limit: Limit) {
        let key = match scope {
            LimitScope::Account => (provider, None),
            LimitScope::Model(family) => (provider, Some(family.clone().unwrap_or_default())),
            LimitScope::Run => return,
        };
        let mut limits = self.lock();
        match limits.get(&key) {
            Some(existing) if existing.until >= limit.until => {}
            _ => {
                limits.insert(key, limit);
            }
        }
    }

    /// Forget the limits that hold back a run of `agent` (the user chose "Resume now").
    pub fn clear(&self, agent: &AgentConfig) {
        let mut limits = self.lock();
        limits.remove(&(agent.provider, None));
        limits.remove(&(agent.provider, Some(model_family(agent))));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Limit>> {
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

    fn claude(model: Option<&str>) -> AgentConfig {
        let mut a = AgentConfig::new(Provider::Claude);
        a.model = model.map(String::from);
        a
    }

    #[test]
    fn a_limit_is_active_until_it_resets_and_the_later_one_wins() {
        let limits = RateLimits::default();
        let any = claude(None);
        assert_eq!(limits.active(&any, 100), None);
        let at = |until| Limit {
            until,
            estimated: false,
        };
        limits.record(Provider::Claude, &LimitScope::Account, at(200));
        limits.record(Provider::Claude, &LimitScope::Account, at(150));
        assert_eq!(limits.active(&any, 100), Some(at(200)));
        assert_eq!(limits.active(&any, 200), None);
        assert_eq!(
            limits.active(&AgentConfig::new(Provider::Cursor), 100),
            None
        );
        limits.clear(&any);
        assert_eq!(limits.active(&any, 100), None);
    }

    #[test]
    fn a_model_limit_holds_back_only_that_model_and_a_run_limit_nobody() {
        let limits = RateLimits::default();
        let at = Limit {
            until: 500,
            estimated: false,
        };
        limits.record(
            Provider::Claude,
            &LimitScope::Model(Some("opus".into())),
            at,
        );
        assert_eq!(
            limits.active(&claude(Some("claude-opus-5-5")), 100),
            Some(at)
        );
        assert_eq!(limits.active(&claude(Some("opus")), 100), Some(at));
        assert_eq!(limits.active(&claude(Some("claude-sonnet-5-5")), 100), None);
        assert_eq!(limits.active(&claude(None), 100), None);
        limits.record(
            Provider::Claude,
            &LimitScope::Run,
            Limit {
                until: 900,
                estimated: true,
            },
        );
        assert_eq!(limits.active(&claude(None), 100), None);
        let mut other = AgentConfig::new(Provider::Cursor);
        other.model = Some("GPT-5".into());
        assert_eq!(
            resolve(LimitScope::Model(None), &other),
            LimitScope::Model(Some("gpt-5".into()))
        );
    }
}
