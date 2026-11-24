//! The run engine: drives tasks through planning, dev, checks, QA and human review, and keeps
//! exactly one durable record of where each task is, so closing, crashing or pausing the app never
//! loses the place.
//!
//! Batch A (this commit): settings, the project lock, agent output types and extraction, prompts,
//! automated checks and the pure step function. The driver, reconcile and commands follow.

pub mod checks;
pub mod extract;
pub mod lock;
pub mod output;
pub mod prompts;
pub mod settings;
pub mod step;
