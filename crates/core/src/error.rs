use std::path::PathBuf;

use crate::task::Phase;

/// Every failure the core can report. Variants carry enough context to be shown to a user as-is.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{path} is not a valid task file: {source}")]
    Corrupt {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("{path} uses task schema {found}; this build reads schema {supported} only")]
    UnsupportedSchema {
        path: PathBuf,
        found: String,
        supported: u32,
    },

    #[error("invalid project directory {path}: {reason}")]
    InvalidProject { path: PathBuf, reason: String },

    #[error("invalid task id {0:?}: use 1-128 letters, digits, '-' or '_'")]
    InvalidTaskId(String),

    #[error("task {0} not found")]
    TaskNotFound(String),

    #[error("task {0} already exists")]
    TaskExists(String),

    #[error("`git {args}` failed: {stderr}")]
    Git { args: String, stderr: String },

    #[error("cannot move task from {from} to {to}: {reason}")]
    Transition {
        from: Phase,
        to: Phase,
        reason: String,
    },

    #[error("update rejected: {0}")]
    Patch(String),

    #[error("invalid task: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// Adapter for `map_err` on I/O calls: attaches the path the call touched.
pub(crate) fn io_at(path: impl Into<PathBuf>) -> impl FnOnce(std::io::Error) -> CoreError {
    let path = path.into();
    move |source| CoreError::Io { path, source }
}
