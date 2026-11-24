//! Code-Automata core: the task store, phase rules and git integration that the Tauri app and its
//! loopback HTTP server are built on. No UI, HTTP or Tauri dependency lives here.

pub mod error;
pub mod git;
pub mod project;
pub mod store;
pub mod task;
pub mod transitions;
pub mod util;

pub use error::{CoreError, Result};
pub use project::ProjectDir;
pub use store::{TaskList, TaskStore};
pub use task::{
    AgentConfig, Phase, PlanningStage, Provider, Run, RunKind, RunState, Subtask, SubtaskKind,
    SubtaskStatus, Task,
};
