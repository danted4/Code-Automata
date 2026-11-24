//! `ca-server`: the HTTP server on its own, for development and the UI's end-to-end tests.
//!
//! ```text
//! ca-server [--port N] [--token T] [--allow-mock [--mock-scenario FILE]]
//! ```
//!
//! Prints `listening on http://127.0.0.1:<port>` and `token <token>`, one per line, once it
//! accepts connections. Ctrl-C (or SIGTERM on Unix) stops it; running tasks are left `interrupted`.
//!
//! With `--allow-mock`, the mock agent is offered. It is found through `CODE_AUTOMATA_MOCK_AGENT`,
//! else next to this binary (`cargo build` puts `mock-agent` there). `--mock-scenario` is the
//! scenario a mock task plays when it names none, as tasks created from the UI do.

use std::process::ExitCode;

use ca_core::Provider;
use ca_core::agent::Binaries;
use ca_server::{AppState, Config, new_token, serve};

struct Args {
    port: u16,
    token: Option<String>,
    allow_mock: bool,
    mock_scenario: Option<std::path::PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        port: 0,
        token: None,
        allow_mock: false,
        mock_scenario: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--port" => {
                let value = it.next().ok_or("--port needs a value")?;
                args.port = value
                    .parse()
                    .map_err(|_| format!("--port: {value:?} is not a port"))?;
            }
            "--token" => {
                let value = it.next().ok_or("--token needs a value")?;
                if value.is_empty() {
                    return Err("--token must not be empty".into());
                }
                args.token = Some(value);
            }
            "--allow-mock" => args.allow_mock = true,
            "--mock-scenario" => {
                let value = it.next().ok_or("--mock-scenario needs a file")?;
                let path = std::path::absolute(&value)
                    .map_err(|e| format!("--mock-scenario {value:?}: {e}"))?;
                args.mock_scenario = Some(path);
            }
            "-h" | "--help" => {
                return Err(
                    "usage: ca-server [--port N] [--token T] [--allow-mock [--mock-scenario FILE]]"
                        .into(),
                );
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("ca-server: cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("ca-server: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<(), String> {
    if args.mock_scenario.is_some() && !args.allow_mock {
        return Err("--mock-scenario needs --allow-mock".into());
    }
    let mut bins = Binaries::from_login_shell().await;
    // git (and the hooks it runs) and checks get the same PATH as the agents.
    if let Some(path) = bins.path_var() {
        ca_core::proc::set_child_path(path.to_owned());
    }
    if args.allow_mock {
        let mock = std::env::var_os("CODE_AUTOMATA_MOCK_AGENT")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                let exe = std::env::current_exe().ok()?;
                let path = exe.with_file_name(format!("mock-agent{}", std::env::consts::EXE_SUFFIX));
                path.exists().then_some(path)
            })
            .ok_or("--allow-mock: no mock-agent found; run `cargo build` or set CODE_AUTOMATA_MOCK_AGENT")?;
        bins = bins.with_override(Provider::Mock, mock);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port))
        .await
        .map_err(|e| format!("cannot listen on 127.0.0.1:{}: {e}", args.port))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("no local address: {e}"))?
        .port();
    let token = args.token.unwrap_or_else(new_token);
    let state = AppState::new(Config {
        token: token.clone(),
        port,
        allow_mock: args.allow_mock,
        mock_scenario: args.mock_scenario,
        bins,
        allowed_origins: Vec::new(),
    });

    println!("listening on http://127.0.0.1:{port}");
    println!("token {token}");
    serve(listener, state, stop_signal())
        .await
        .map_err(|e| format!("server error: {e}"))
}

/// Ctrl-C, or SIGTERM on Unix (what `kill` and process managers send).
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
