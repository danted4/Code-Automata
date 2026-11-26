fn main() {
    // The page may call only these commands; capabilities/main.json allows each one.
    let commands = &[
        "pick_folder",
        "pick_file",
        "available_editors",
        "path_exists",
        "open_in_editor",
        "reveal_folder",
        "smoke_report",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .unwrap_or_else(|e| panic!("tauri-build: {e:#}"));
}
