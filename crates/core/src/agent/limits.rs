//! Recognising that a CLI stopped because its subscription's usage limit was reached, and when the
//! limit resets.
//!
//! Only a run's final result, its error events and its stderr are looked at, never what the agent
//! wrote (an agent working on rate limiting must not pause its own task). Each CLI words this
//! differently and changes the wording between releases, so a structured reset time (Claude's
//! `rate_limit_event`) wins over text, and text that names no time still counts as a limit with an
//! unknown reset.

use jiff::civil::{Date, Weekday};
use jiff::tz::TimeZone;
use jiff::{ToSpan, ZonedDateTime};

/// A usage limit, and when it resets (seconds since the epoch) if the CLI said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub resets_at: Option<i64>,
}

/// Claude Code's text for a usage limit: "You've hit your session limit · resets 3:45pm
/// (Asia/Tokyo)", "5-hour limit reached ∙ resets 3pm", "… weekly limit · resets Mon 12:00am", or
/// the older "Claude AI usage limit reached|1764000000".
pub fn claude_text(text: &str, now: &ZonedDateTime) -> Option<RateLimit> {
    let lower = text.to_lowercase();
    if let Some((_, epoch)) = text.split_once("usage limit reached|")
        && let Ok(at) = epoch.trim().parse::<i64>()
    {
        return Some(RateLimit {
            resets_at: Some(at),
        });
    }
    // Named limits only: "context limit reached" or "turn limit" are not usage limits.
    const KINDS: [&str; 8] = [
        "usage limit",
        "session limit",
        "weekly limit",
        "5-hour limit",
        "opus limit",
        "sonnet limit",
        "fable limit",
        "haiku limit",
    ];
    let limited = KINDS.iter().any(|k| lower.contains(k))
        || (lower.contains("hit your") && lower.contains("limit"));
    if !limited {
        return None;
    }
    let resets_at = lower
        .find("resets")
        .and_then(|i| parse_when(&text[i + "resets".len()..], now));
    Some(RateLimit { resets_at })
}

/// Codex's text: "You've hit your usage limit. … try again at 3:45 PM." or "… Try again at Nov
/// 30th, 2026 3:45 PM." (local time; either apostrophe). Running out of workspace credits or a
/// spend cap is a limit too, with no reset.
pub fn codex_text(text: &str, now: &ZonedDateTime) -> Option<RateLimit> {
    let lower = text.to_lowercase().replace('\u{2019}', "'");
    let limited = lower.contains("you've hit your usage limit")
        || lower.contains("out of credits")
        || lower.contains("hit your spend cap");
    if !limited {
        return None;
    }
    let resets_at = lower.find("try again at").and_then(|i| {
        let rest = &lower[i + "try again at".len()..];
        // The sentence ends at ". " or the end; a time has no ". " inside it.
        let end = rest.find(". ").unwrap_or(rest.len());
        parse_when(rest[..end].trim_end_matches('.'), now)
    });
    Some(RateLimit { resets_at })
}

/// Gemini CLI's quota errors (`RESOURCE_EXHAUSTED`, "You have exhausted your daily quota", HTTP
/// 429). Gemini gives no reset time.
pub fn gemini_text(text: &str) -> Option<RateLimit> {
    let lower = text.to_lowercase();
    let limited = lower.contains("resource_exhausted")
        || lower.contains("exhausted your")
        || lower.contains("quota exceeded")
        || lower.contains("rate limit")
        || lower.contains("status 429")
        || lower.contains("code: 429")
        || lower.contains("\"code\":429");
    limited.then_some(RateLimit { resets_at: None })
}

/// Cursor Agent's usage-limit errors (on stderr or an error line); no reset time is given.
pub fn cursor_text(text: &str) -> Option<RateLimit> {
    let lower = text.to_lowercase().replace('\u{2019}', "'");
    let limited = lower.contains("hit your usage limit")
        || lower.contains("usage_limit_exceeded")
        || lower.contains("resource_exhausted")
        || lower.contains("usage limit reached");
    limited.then_some(RateLimit { resets_at: None })
}

/// Amp documents no limit wording; only an explicit "rate limit" counts.
pub fn amp_text(text: &str) -> Option<RateLimit> {
    text.to_lowercase()
        .contains("rate limit")
        .then_some(RateLimit { resets_at: None })
}

/// The local time zone's "now", for the parsers above.
pub fn local_now() -> ZonedDateTime {
    ZonedDateTime::now()
}

/// When a time like "3:45pm", "3 PM", "15:45", "Mon 12:00am", "Nov 30th, 2026 3:45 PM" or "Dec 17
/// at 6am", optionally followed by a zone in parentheses ("(Asia/Tokyo)"), next comes after `now`
/// (seconds since the epoch). A time with no date is today's, or tomorrow's once it has passed; a
/// weekday is the next one; a month and day without a year is the next one too.
pub fn parse_when(text: &str, now: &ZonedDateTime) -> Option<i64> {
    let (text, tz) = match (text.find('('), text.find(')')) {
        (Some(open), Some(close)) if open < close => {
            let name = text[open + 1..close].trim();
            let tz = TimeZone::get(name).unwrap_or_else(|_| now.time_zone().clone());
            (text[..open].to_string(), tz)
        }
        _ => (text.to_string(), now.time_zone().clone()),
    };
    let now = now.timestamp().to_zoned_datetime(tz.clone());
    let cleaned = text
        .to_lowercase()
        .replace([',', '·', '∙', '•'], " ")
        .replace(" at ", " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();

    let mut clock: Option<(i8, i8)> = None;
    let mut weekday: Option<Weekday> = None;
    let mut month: Option<i8> = None;
    let mut day: Option<i8> = None;
    let mut year: Option<i16> = None;
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i].trim_end_matches('.');
        let next = tokens.get(i + 1).map(|t| t.trim_end_matches('.'));
        if let Some(c) = parse_clock(token, next) {
            clock = Some(c.0);
            i += c.1;
            continue;
        }
        if let Some(w) = parse_weekday(token) {
            weekday = Some(w);
        } else if let Some(m) = parse_month(token) {
            month = Some(m);
        } else if let Some(n) = parse_number(token) {
            if n >= 1000 {
                year = i16::try_from(n).ok();
            } else if month.is_some() && day.is_none() {
                day = i8::try_from(n).ok();
            }
        }
        i += 1;
    }
    let (hour, minute) = clock?;
    let today = now.date();
    let at = |date: Date| {
        date.at(hour, minute, 0, 0)
            .to_zoned_datetime(tz.clone())
            .ok()
    };
    let when = if let (Some(month), Some(day)) = (month, day) {
        let mut date = Date::new(year.unwrap_or(today.year()), month, day).ok()?;
        if year.is_none() && at(date)?.timestamp() <= now.timestamp() {
            date = Date::new(today.year() + 1, month, day).ok()?;
        }
        at(date)?
    } else if let Some(weekday) = weekday {
        let ahead = i64::from(weekday.since(today.weekday()));
        let mut candidate = at(today.checked_add(ahead.days()).ok()?)?;
        if candidate.timestamp() <= now.timestamp() {
            candidate = at(today.checked_add((ahead + 7).days()).ok()?)?;
        }
        candidate
    } else {
        let mut candidate = at(today)?;
        if candidate.timestamp() <= now.timestamp() {
            candidate = at(today.tomorrow().ok()?)?;
        }
        candidate
    };
    Some(when.timestamp().as_second())
}

/// "3:45pm", "3pm", "3:45" + "pm", "15:45". Returns the time and how many tokens it used.
fn parse_clock(token: &str, next: Option<&str>) -> Option<((i8, i8), usize)> {
    let (body, suffix, used) = if let Some(b) = token.strip_suffix("am") {
        (b, Some(false), 1)
    } else if let Some(b) = token.strip_suffix("pm") {
        (b, Some(true), 1)
    } else {
        match next {
            Some("am") => (token, Some(false), 2),
            Some("pm") => (token, Some(true), 2),
            _ => (token, None, 1),
        }
    };
    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h.parse::<i8>().ok()?, m.parse::<i8>().ok()?),
        // A bare number is a clock only with am/pm ("3pm"); otherwise it is a day or year.
        None if suffix.is_some() => (body.parse::<i8>().ok()?, 0),
        None => return None,
    };
    if !(0..60).contains(&m) {
        return None;
    }
    let hour = match suffix {
        Some(pm) if (1..=12).contains(&h) => (h % 12) + if pm { 12 } else { 0 },
        Some(_) => return None,
        None if (0..24).contains(&h) => h,
        None => return None,
    };
    Some(((hour, m), used))
}

fn parse_weekday(token: &str) -> Option<Weekday> {
    const DAYS: [Weekday; 7] = [
        Weekday::Monday,
        Weekday::Tuesday,
        Weekday::Wednesday,
        Weekday::Thursday,
        Weekday::Friday,
        Weekday::Saturday,
        Weekday::Sunday,
    ];
    name_index(token, WEEKDAYS).map(|i| DAYS[i])
}

fn parse_month(token: &str) -> Option<i8> {
    name_index(token, MONTHS).and_then(|i| i8::try_from(i + 1).ok())
}

/// The index of the name `token` abbreviates (at least three letters: "mon", "sept", "november").
fn name_index(token: &str, names: &[&str]) -> Option<usize> {
    (token.len() >= 3)
        .then(|| names.iter().position(|n| n.starts_with(token)))
        .flatten()
}

const WEEKDAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

const MONTHS: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// "30", "30th", "1st", "2026".
fn parse_number(token: &str) -> Option<i32> {
    let digits = token.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let suffix = &token[digits.len()..];
    if !["", "st", "nd", "rd", "th"].contains(&suffix) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// Friday 28 November 2026, 14:00 in UTC.
    fn now() -> ZonedDateTime {
        Date::new(2026, 11, 28)
            .unwrap()
            .at(14, 0, 0, 0)
            .to_zoned_datetime(TimeZone::UTC)
            .unwrap()
    }

    fn utc(y: i16, mo: i8, d: i8, h: i8, mi: i8) -> i64 {
        Date::new(y, mo, d)
            .unwrap()
            .at(h, mi, 0, 0)
            .to_zoned_datetime(TimeZone::UTC)
            .unwrap()
            .timestamp()
            .as_second()
    }

    #[test]
    fn clock_times_are_today_or_tomorrow() {
        assert_eq!(
            parse_when("3:45pm", &now()),
            Some(utc(2026, 11, 28, 15, 45))
        );
        assert_eq!(parse_when(" 3 PM", &now()), Some(utc(2026, 11, 28, 15, 0)));
        assert_eq!(parse_when("9am", &now()), Some(utc(2026, 11, 29, 9, 0)));
        assert_eq!(parse_when("12:00am", &now()), Some(utc(2026, 11, 29, 0, 0)));
        assert_eq!(parse_when("12pm", &now()), Some(utc(2026, 11, 29, 12, 0)));
        assert_eq!(parse_when("15:45", &now()), Some(utc(2026, 11, 28, 15, 45)));
        assert_eq!(parse_when("soon", &now()), None);
        assert_eq!(parse_when("13pm", &now()), None);
    }

    #[test]
    fn weekdays_and_dates_are_the_next_ones() {
        // 28 November 2026 is a Saturday.
        assert_eq!(
            parse_when("Mon 12:00am", &now()),
            Some(utc(2026, 11, 30, 0, 0))
        );
        assert_eq!(parse_when("Sat 1pm", &now()), Some(utc(2026, 12, 5, 13, 0)));
        assert_eq!(
            parse_when("Nov 30th, 2026 3:45 PM", &now()),
            Some(utc(2026, 11, 30, 15, 45))
        );
        assert_eq!(
            parse_when("Dec 17 at 6am", &now()),
            Some(utc(2026, 12, 17, 6, 0))
        );
        assert_eq!(
            parse_when("January 2 9:00", &now()),
            Some(utc(2027, 1, 2, 9, 0))
        );
    }

    #[test]
    fn a_named_zone_is_honoured() {
        // 15:50 in Tokyo (UTC+9) is 06:50 UTC, already past at 14:00 UTC: tomorrow.
        assert_eq!(
            parse_when("3:50pm (Asia/Tokyo)", &now()),
            Some(utc(2026, 11, 29, 6, 50))
        );
        // An unknown zone falls back to now's.
        assert_eq!(
            parse_when("3:50pm (Nowhere/Else)", &now()),
            Some(utc(2026, 11, 28, 15, 50))
        );
    }

    #[test]
    fn claude_wordings() {
        let at = |t: &str| claude_text(t, &now()).map(|l| l.resets_at);
        assert_eq!(
            at("You've hit your session limit · resets 3:45pm"),
            Some(Some(utc(2026, 11, 28, 15, 45)))
        );
        assert_eq!(
            at("5-hour limit reached ∙ resets 3pm"),
            Some(Some(utc(2026, 11, 28, 15, 0)))
        );
        assert_eq!(
            at("You've hit your weekly limit · resets Mon 12:00am"),
            Some(Some(utc(2026, 11, 30, 0, 0)))
        );
        assert_eq!(
            at("Claude AI usage limit reached|1764000000"),
            Some(Some(1_764_000_000))
        );
        assert_eq!(at("You've hit your Opus limit"), Some(None));
        assert_eq!(at("API Error: 500 Internal server error"), None);
        assert_eq!(at("the tests failed"), None);
        assert_eq!(at("Context window limit reached"), None);
        assert_eq!(at("Reached max turns limit"), None);
    }

    #[test]
    fn codex_wordings() {
        let at = |t: &str| codex_text(t, &now()).map(|l| l.resets_at);
        assert_eq!(
            at(
                "You\u{2019}ve hit your usage limit. Upgrade to Pro (https://x.y/z) or try again at 3:45 PM."
            ),
            Some(Some(utc(2026, 11, 28, 15, 45)))
        );
        assert_eq!(
            at("You've hit your usage limit. Try again at Nov 30th, 2026 3:45 PM."),
            Some(Some(utc(2026, 11, 30, 15, 45)))
        );
        assert_eq!(
            at("Your workspace is out of credits. Ask an admin."),
            Some(None)
        );
        assert_eq!(at("stream disconnected before completion"), None);
    }

    #[test]
    fn gemini_cursor_and_amp_wordings() {
        assert!(
            gemini_text("[API Error: You have exhausted your daily quota on this model.]")
                .is_some()
        );
        assert!(gemini_text("RESOURCE_EXHAUSTED").is_some());
        assert!(gemini_text("Please check your network").is_none());
        assert!(cursor_text("Error: You've hit your usage limit for this cycle").is_some());
        assert!(cursor_text("{\"type\":\"error\",\"code\":\"usage_limit_exceeded\"}").is_some());
        assert!(cursor_text("Error: not logged in").is_none());
        assert!(amp_text("Rate limit exceeded, try later").is_some());
        assert!(amp_text("Insufficient credits").is_none());
    }
}
