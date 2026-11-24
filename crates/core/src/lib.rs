//! Code-Automata core: the task store, phase rules and git integration that the Tauri app and its
//! loopback HTTP server are built on. No UI, HTTP or Tauri dependency lives here.
//!
//! Phase 1 of the 3.0 migration: the run engine and CLI adapters come in later phases.

pub mod error;
pub mod git;
pub mod migrate;
pub mod project;
pub mod store;
pub mod task;
pub mod transitions;
pub mod util;

pub use error::{CoreError, Result};
pub use project::ProjectDir;
pub use store::{NewTask, TaskList, TaskStore};
pub use task::{Phase, Run, RunKind, RunState, Subtask, SubtaskType, Task, TaskStatus};
