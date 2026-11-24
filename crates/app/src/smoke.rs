//! `CODE_AUTOMATA_SMOKE=1`: start the real app, check the path from the webview to the server and
//! back, print the result and exit (0 if every check passed). CI runs it on macOS, Windows and
//! Linux; it is the only automated test of the platform webviews, which agent-browser cannot
//! drive.
//!
//! The checks run in the page, after the UI has rendered its open-project dialog:
//! `GET /api/providers` with the token (CORS and auth), the event stream of a scratch project up to
//! its `hello` (a long-lived cross-origin stream), and the `available_editors` and `path_exists`
//! commands (IPC and the path rule).

use std::time::Duration;

use tauri::AppHandle;

const LIMIT: Duration = Duration::from_secs(90);

pub fn requested() -> bool {
    std::env::var_os("CODE_AUTOMATA_SMOKE").is_some_and(|v| v == "1")
}

/// Make the scratch project, start the time limit, and return the page script.
pub fn prepare() -> Result<String, Box<dyn std::error::Error>> {
    let project = std::env::temp_dir().join(format!("code-automata-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&project);
    std::fs::create_dir_all(&project)?;
    std::fs::write(project.join("README.md"), "smoke\n")?;
    tauri::async_runtime::block_on(async {
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.name=Smoke",
                "-c",
                "user.email=smoke@example.com",
                "add",
                "-A",
            ],
            &[
                "-c",
                "user.name=Smoke",
                "-c",
                "user.email=smoke@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        ] {
            let out = ca_core::proc::command("git")
                .args(args)
                .current_dir(&project)
                .output()
                .await?;
            if !out.status.success() {
                return Err(
                    format!("git {args:?}: {}", String::from_utf8_lossy(&out.stderr)).into(),
                );
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;
    let project = ca_core::util::plain_path(std::fs::canonicalize(&project)?);

    std::thread::spawn(|| {
        std::thread::sleep(LIMIT);
        println!("smoke: FAILED: no result within {} s", LIMIT.as_secs());
        std::process::exit(1);
    });
    Ok(SCRIPT.replace(
        "__PROJECT__",
        &serde_json::to_string(&project.to_string_lossy())?,
    ))
}

#[tauri::command]
pub fn smoke_report(app: AppHandle, ok: bool, detail: String) {
    if !requested() {
        return;
    }
    println!("smoke: {}: {detail}", if ok { "passed" } else { "FAILED" });
    crate::request_quit(&app, if ok { 0 } else { 1 }, false);
}

const SCRIPT: &str = r#"
;(() => {
  const PROJECT = __PROJECT__;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const until = async (what, f) => {
    for (let i = 0; i < 600; i++) {
      const v = f();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for ' + what);
  };
  const run = async () => {
    await until('the open-project dialog', () => document.querySelector('#project-path'));
    const { baseUrl, token } = window.__CODE_AUTOMATA__;
    const auth = { Authorization: 'Bearer ' + token };
    const providers = await fetch(baseUrl + '/api/providers', { headers: auth });
    if (!providers.ok) throw new Error('GET /api/providers: ' + providers.status);
    const list = await providers.json();

    const events = await fetch(baseUrl + '/api/events', {
      headers: { ...auth, 'X-Project-Path': encodeURIComponent(PROJECT) },
    });
    if (!events.ok) throw new Error('GET /api/events: ' + events.status + ' ' + (await events.text()));
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('hello')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the event stream ended before hello: ' + text);
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    const editors = await invoke('available_editors');
    if (!Array.isArray(editors) || editors.length !== 2) throw new Error('editors: ' + JSON.stringify(editors));
    if (!(await invoke('path_exists', { path: PROJECT }))) throw new Error('path_exists refused the open project');
    if (await invoke('path_exists', { path: '/' })) throw new Error('path_exists allowed a folder outside every project');
    return 'providers ' + JSON.stringify(list) + '; editors ' + JSON.stringify(editors);
  };
  const start = () =>
    run().then(
      (detail) => invoke('smoke_report', { ok: true, detail }),
      (e) => invoke('smoke_report', { ok: false, detail: String((e && e.stack) || e) })
    );
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
"#;
