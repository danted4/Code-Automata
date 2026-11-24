//! Every process the app starts must go through `ca_core::proc::command`, which on Windows sets
//! `CREATE_NO_WINDOW`. A plain `Command::new` there opens a console window from the GUI app for
//! each `git`, agent or check run; tests run from a console and would never show it.
//!
//! This scans the non-test code of the crates the app ships. Development binaries (`src/bin/`)
//! and test modules (everything after a file's first `#[cfg(test)]`) are skipped.
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == "bin") {
                continue;
            }
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn processes_are_started_without_a_console_window() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for name in ["core", "server", "app"] {
        let src = crates.join(name).join("src");
        if src.is_dir() {
            rust_files(&src, &mut files);
        }
    }
    assert!(files.len() > 20, "found only {} files", files.len());
    let allowed = crates.join("core").join("src").join("proc.rs");

    let mut found = Vec::new();
    for file in files.iter().filter(|f| **f != allowed) {
        let text = std::fs::read_to_string(file).unwrap();
        let code = text.split("#[cfg(test)]").next().unwrap_or("");
        for (n, line) in code.lines().enumerate() {
            if line.contains("Command::new(") && !line.trim_start().starts_with("//") {
                found.push(format!("{}:{}: {}", file.display(), n + 1, line.trim()));
            }
        }
    }
    assert!(
        found.is_empty(),
        "use ca_core::proc::command instead of Command::new:\n{}",
        found.join("\n")
    );
}
