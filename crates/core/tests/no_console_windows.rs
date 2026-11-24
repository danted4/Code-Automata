//! Every process the app starts must go through `ca_core::proc::command`, which on Windows sets
//! `CREATE_NO_WINDOW`. A plain `Command::new` there opens a console window from the GUI app for
//! each `git`, agent or check run; tests run from a console and would never show it.
//!
//! This scans the non-test code of the crates the app ships. Development binaries (`src/bin/`)
//! and `#[cfg(test)] mod … { … }` blocks are skipped; everything else, including code after a
//! test module or a test-only item, is scanned.
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

/// The lines of `text` outside `#[cfg(test)] mod name { ... }` blocks, with their line numbers.
/// Braces are counted per line, which is enough for rustfmt-formatted code.
fn shipped_lines(text: &str) -> Vec<(usize, &str)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        // Other attributes may sit between `#[cfg(test)]` and the `mod` line.
        let mut item = i + 1;
        while lines
            .get(item)
            .is_some_and(|l| l.trim_start().starts_with("#["))
        {
            item += 1;
        }
        let is_test_mod = lines[i].trim() == "#[cfg(test)]"
            && lines.get(item).is_some_and(|next| {
                let next = next.trim_start();
                (next.starts_with("mod ") || next.starts_with("pub mod ")) && next.ends_with('{')
            });
        if is_test_mod {
            let mut depth = 0i64;
            let mut j = item;
            while j < lines.len() {
                depth += lines[j].matches('{').count() as i64;
                depth -= lines[j].matches('}').count() as i64;
                j += 1;
                if depth <= 0 {
                    break;
                }
            }
            i = j;
            continue;
        }
        out.push((i + 1, lines[i]));
        i += 1;
    }
    out
}

#[test]
fn only_test_modules_are_skipped() {
    let text = "use a;\n#[cfg(test)]\nuse b;\nfn x() { Command::new(1) }\n#[cfg(test)]\n#[allow(x)]\nmod tests {\n    fn t() {\n        Command::new(2);\n    }\n}\nfn y() { Command::new(3) }\n";
    let kept: Vec<&str> = shipped_lines(text).into_iter().map(|(_, l)| l).collect();
    assert!(kept.iter().any(|l| l.contains("Command::new(1)")));
    assert!(kept.iter().any(|l| l.contains("Command::new(3)")));
    assert!(!kept.iter().any(|l| l.contains("Command::new(2)")));
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
        for (n, line) in shipped_lines(&text) {
            if line.contains("Command::new(") && !line.trim_start().starts_with("//") {
                found.push(format!("{}:{n}: {}", file.display(), line.trim()));
            }
        }
    }
    assert!(
        found.is_empty(),
        "use ca_core::proc::command instead of Command::new:\n{}",
        found.join("\n")
    );
}
