//! Each agent run's events in provider-independent form, for the UI to replay.
//!
//! `tasks/<id>/runs/<run>-<attempt>-<label>.events.ndjson`, next to the provider's raw log
//! (`….ndjson`). The first line describes the run; every later line is one [`AgentEvent`] with
//! the time it arrived. Writing is best effort: a full disk must not stop a run.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

use crate::agent::AgentEvent;
use crate::error::{CoreError, Result, io_at};
use crate::task::{Provider, RunKind};
use crate::util::now_ms;

const SUFFIX: &str = ".events.ndjson";

/// One line of a run's event log.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "line",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunLogLine {
    /// Always the first line.
    Start {
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        at: i64,
        run_id: String,
        attempt: u32,
        /// `run` for the step itself, `triage` for the check before resuming an interrupted
        /// subtask; either with `-repair` for a turn that fixes an unreadable answer.
        label: String,
        kind: RunKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtask_id: Option<String>,
        provider: Provider,
    },
    Event {
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        at: i64,
        /// 1-based position among this log's events; the live event carries the same number.
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        seq: u64,
        event: AgentEvent,
    },
    /// The agent never started. Always the last line.
    Abandoned {
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        at: i64,
        reason: String,
    },
}

/// What the run list shows for one logged agent run.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogInfo {
    /// The log's name, used to fetch its events.
    pub name: String,
    pub run_id: String,
    pub attempt: u32,
    pub label: String,
    pub kind: RunKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
    pub provider: Provider,
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub started_at: i64,
    /// How the agent's run ended. Absent while it runs, and also when the log stops without an
    /// ending because the app quit or crashed mid-run; the task's `run` tells the two apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<crate::agent::Outcome>,
    /// Why the agent never started, when it did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abandoned: Option<String>,
}

/// Appends a run's events to its log.
pub(crate) struct RunLogWriter {
    file: Option<File>,
    /// Events written so far.
    seq: u64,
}

impl RunLogWriter {
    /// Open the log beside `raw_log` and write its start line. Never fails: without a file the
    /// writer does nothing.
    pub async fn create(raw_log: &Path, start: RunLogLine) -> RunLogWriter {
        let path = events_path(raw_log);
        let file = match path.parent() {
            Some(dir) if tokio::fs::create_dir_all(dir).await.is_err() => None,
            _ => tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .await
                .ok(),
        };
        let mut writer = RunLogWriter { file, seq: 0 };
        writer.write(&start).await;
        writer
    }

    /// Log the event and return its number, counted even when the file cannot be written.
    pub async fn event(&mut self, event: &AgentEvent) -> u64 {
        self.seq += 1;
        let line = RunLogLine::Event {
            at: now_ms(),
            seq: self.seq,
            event: event.clone(),
        };
        self.write(&line).await;
        self.seq
    }

    /// The agent could not be started: end the log with why.
    pub async fn abandon(&mut self, reason: &str) {
        let line = RunLogLine::Abandoned {
            at: now_ms(),
            reason: reason.to_string(),
        };
        self.write(&line).await;
    }

    async fn write(&mut self, line: &RunLogLine) {
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let Ok(mut text) = serde_json::to_string(line) else {
            return;
        };
        text.push('\n');
        // tokio's File hands writes to a blocking thread and keeps them until flushed: without
        // the flush, a reader (or a writer dropped after `finished`) may not see the line yet.
        let written = async {
            file.write_all(text.as_bytes()).await?;
            file.flush().await
        };
        if written.await.is_err() {
            self.file = None;
        }
    }
}

/// `<raw log without .ndjson>.events.ndjson`.
fn events_path(raw_log: &Path) -> PathBuf {
    let name = raw_log
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("run.ndjson");
    let stem = name.strip_suffix(".ndjson").unwrap_or(name);
    raw_log.with_file_name(format!("{stem}{SUFFIX}"))
}

/// The task's logged agent runs, oldest first. Logs that cannot be read are left out.
pub(crate) async fn list(runs_dir: &Path) -> Result<Vec<RunLogInfo>> {
    let mut entries = match tokio::fs::read_dir(runs_dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_at(runs_dir)(e)),
    };
    let mut runs = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(io_at(runs_dir))? {
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(SUFFIX) else {
            continue;
        };
        if let Ok(Some(info)) = summarize(&entry.path(), stem).await {
            runs.push(info);
        }
    }
    runs.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.name.cmp(&b.name)));
    Ok(runs)
}

async fn summarize(path: &Path, name: &str) -> Result<Option<RunLogInfo>> {
    let lines = read_lines(path).await?;
    let Some(RunLogLine::Start {
        at,
        run_id,
        attempt,
        label,
        kind,
        subtask_id,
        provider,
    }) = lines.first().cloned()
    else {
        return Ok(None);
    };
    let outcome = lines.iter().rev().find_map(|l| match l {
        RunLogLine::Event {
            event: AgentEvent::Finished { outcome },
            ..
        } => Some(outcome.clone()),
        _ => None,
    });
    let abandoned = lines.iter().rev().find_map(|l| match l {
        RunLogLine::Abandoned { reason, .. } => Some(reason.clone()),
        _ => None,
    });
    Ok(Some(RunLogInfo {
        name: name.to_string(),
        run_id,
        attempt,
        label,
        kind,
        subtask_id,
        provider,
        started_at: at,
        outcome,
        abandoned,
    }))
}

/// Every line of one run's log, by the name [`list`] gave it. Unreadable lines (a write cut
/// short by a crash) are skipped.
pub(crate) async fn read(runs_dir: &Path, name: &str) -> Result<Vec<RunLogLine>> {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(CoreError::NotFound(format!("run log {name:?}")));
    }
    let path = runs_dir.join(format!("{name}{SUFFIX}"));
    match tokio::fs::try_exists(&path).await {
        Ok(true) => read_lines(&path).await,
        _ => Err(CoreError::NotFound(format!("run log {name}"))),
    }
}

async fn read_lines(path: &Path) -> Result<Vec<RunLogLine>> {
    let text = tokio::fs::read_to_string(path).await.map_err(io_at(path))?;
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_events_log_sits_beside_the_raw_log() {
        let raw = Path::new("/p/runs/run-1-1-run.ndjson");
        assert_eq!(
            events_path(raw),
            Path::new("/p/runs/run-1-1-run.events.ndjson")
        );
    }

    #[tokio::test]
    async fn a_log_reads_back_with_its_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("run-7-1-run.ndjson");
        let mut w = RunLogWriter::create(
            &raw,
            RunLogLine::Start {
                at: 5,
                run_id: "run-7".into(),
                attempt: 1,
                label: "run".into(),
                kind: RunKind::Dev,
                subtask_id: Some("dev-1".into()),
                provider: Provider::Mock,
            },
        )
        .await;
        w.event(&AgentEvent::Text { text: "hi".into() }).await;
        drop(w);
        // A torn last line is skipped, not an error.
        let path = dir.path().join("run-7-1-run.events.ndjson");
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"line\":\"ev");
        std::fs::write(&path, text).unwrap();

        let runs = list(dir.path()).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].name, "run-7-1-run");
        assert_eq!(runs[0].subtask_id.as_deref(), Some("dev-1"));
        assert!(runs[0].outcome.is_none());

        let lines = read(dir.path(), "run-7-1-run").await.unwrap();
        assert_eq!(lines.len(), 2);
        assert!(matches!(
            read(dir.path(), "../x").await,
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            read(dir.path(), "nope").await,
            Err(CoreError::NotFound(_))
        ));
    }
}
