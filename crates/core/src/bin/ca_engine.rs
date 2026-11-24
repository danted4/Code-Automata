//! `ca-engine`: run the Code-Automata engine on a project from the command line.
//!
//! ```text
//! ca-engine <project dir> start  <task id>   run the task until it waits, finishes or halts
//! ca-engine <project dir> resume <task id>   continue a paused, interrupted or failed task
//! ca-engine <project dir> status <task id>   print the task's phase and run state
//! ```
//!
//! Agent CLIs are found on `PATH`; `CODE_AUTOMATA_MOCK_AGENT` points at the mock agent binary.
//! Engine events are printed one per line. For development and tests; the app uses the library.

use ca_core::agent::Binaries;
use ca_core::engine::{Engine, EngineEvent};
use ca_core::{ProjectDir, Provider};

fn main() {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("ca-engine: {e}");
            std::process::exit(1);
        }
    };
    std::process::exit(runtime.block_on(run()));
}

async fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [project, command, task_id] = args.as_slice() else {
        eprintln!("usage: ca-engine <project dir> start|resume|status <task id>");
        return 2;
    };
    let project = match ProjectDir::open(project).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ca-engine: {e}");
            return 1;
        }
    };
    let mut bins = Binaries::from_env();
    if let Some(mock) = std::env::var_os("CODE_AUTOMATA_MOCK_AGENT") {
        bins = bins.with_override(Provider::Mock, mock);
    }
    let engine = match Engine::open(project, bins).await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("ca-engine: {e}");
            return 1;
        }
    };

    let mut events = engine.subscribe();
    let printer = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            match event {
                EngineEvent::TaskChanged { task_id } => println!("task-changed {task_id}"),
                EngineEvent::Error { task_id, message } => println!("error {task_id} {message}"),
                EngineEvent::Agent { run_id, event, .. } => {
                    println!(
                        "agent {run_id} {}",
                        serde_json::to_string(&event).unwrap_or_default()
                    );
                }
            }
        }
    });

    let started = match command.as_str() {
        "start" => engine.start(task_id).await,
        "resume" => engine.resume(task_id).await,
        "status" => Ok(()),
        other => {
            eprintln!("ca-engine: unknown command {other:?}");
            return 2;
        }
    };
    if let Err(e) = started {
        eprintln!("ca-engine: {e}");
        return 1;
    }
    engine.wait_idle(task_id).await;
    printer.abort();

    match engine.get_task(task_id).await {
        Ok(Some(task)) => {
            let run = task
                .run
                .as_ref()
                .map(|r| format!("{:?} {:?} {:?}", r.kind, r.state, r.error))
                .unwrap_or_else(|| "no run".into());
            println!("status {} {run}", task.phase);
            0
        }
        Ok(None) => {
            eprintln!("ca-engine: no task {task_id}");
            1
        }
        Err(e) => {
            eprintln!("ca-engine: {e}");
            1
        }
    }
}
