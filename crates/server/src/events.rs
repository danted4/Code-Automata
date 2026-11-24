//! `GET /api/events`: one project's task changes and agent output as Server-Sent Events.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use ca_core::Task;
use ca_core::agent::AgentEvent;
use ca_core::engine::{Engine, EngineEvent};
use serde::Serialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::state::{AppState, Project};

/// One message on the event stream. Each SSE `data:` line is one of these as JSON.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerEvent {
    /// First message of every stream, a reconnect included: load the task list now, since
    /// anything before it was missed.
    Hello,
    /// The task changed. `task` is its new state, or null when the task was deleted.
    Task {
        task_id: String,
        task: Option<Box<Task>>,
    },
    /// The task changed but could not be read just now: fetch it again.
    Reload { task_id: String },
    /// An agent working on the task did something. `seq` is the event's number in its run log,
    /// so a client that replayed the log can skip what it already has.
    Agent {
        task_id: String,
        run_id: String,
        /// The run log it belongs to (`RunLogInfo.name`); `seq` counts within that log.
        log: String,
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        seq: u64,
        event: AgentEvent,
    },
    /// The task's driver stopped on an error with no run to record it on.
    Error { task_id: String, message: String },
    /// The client fell behind and `missed` messages were dropped: load the task list again.
    Lagged {
        #[cfg_attr(feature = "ts", ts(as = "f64"))]
        missed: u64,
    },
}

pub async fn stream(
    State(state): State<Arc<AppState>>,
    Project(engine): Project,
) -> impl axum::response::IntoResponse {
    let (tx, rx) = mpsc::channel(256);
    let mut engine_events = engine.subscribe();
    let mut closing = state.closing();
    tokio::spawn(async move {
        if !send(&tx, &mut closing, &ServerEvent::Hello).await {
            return;
        }
        loop {
            let next = tokio::select! {
                next = engine_events.recv() => next,
                _ = closing.wait_for(|c| *c) => return,
            };
            let message = match next {
                Ok(event) => convert(&engine, event).await,
                Err(RecvError::Lagged(missed)) => ServerEvent::Lagged { missed },
                Err(RecvError::Closed) => return,
            };
            if !send(&tx, &mut closing, &message).await {
                return; // the client went away, or the server is closing
            }
        }
    });
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

async fn convert(engine: &Engine, event: EngineEvent) -> ServerEvent {
    match event {
        EngineEvent::TaskChanged { task_id } => match engine.get_task(&task_id).await {
            Ok(task) => ServerEvent::Task {
                task_id,
                task: task.map(Box::new),
            },
            Err(_) => ServerEvent::Reload { task_id },
        },
        EngineEvent::Agent {
            task_id,
            run_id,
            log,
            seq,
            event,
        } => ServerEvent::Agent {
            task_id,
            run_id,
            log,
            seq,
            event,
        },
        EngineEvent::Error { task_id, message } => ServerEvent::Error { task_id, message },
    }
}

/// False when the client is gone or the server is closing. A client that stops reading fills
/// the channel; the send then waits, so it also gives way to shutdown.
async fn send(
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    closing: &mut tokio::sync::watch::Receiver<bool>,
    message: &ServerEvent,
) -> bool {
    let event = Event::default()
        .json_data(message)
        .unwrap_or_else(|_| Event::default().data("{}"));
    tokio::select! {
        sent = tx.send(Ok(event)) => sent.is_ok(),
        _ = closing.wait_for(|c| *c) => false,
    }
}
