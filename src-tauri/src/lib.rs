mod claude;
mod claude_hooks;
mod config;
mod download;
mod hooks;
mod meta;
mod pty;
mod tmux;

use pty::PtyManager;

/// Sous-commande `noobmux --hook <event>` : lit un payload JSON sur stdin
/// (protocole hooks de Claude Code), l'envoie sur la socket Unix noobmux pour
/// que la GUI puisse mettre à jour le statut de la session. Non-bloquant
/// (silencieusement no-op si noobmux n'est pas lancé).
pub fn hook_cli(event: &str) -> i32 {
    use std::io::Read;
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    let payload: serde_json::Value = serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null);
    let session_id = std::env::var("NOOBMUX_SESSION_ID").ok();
    // Le payload des hooks Claude Code contient son propre `session_id` (l'UUID
    // de la session Claude) et le `cwd`. On les remonte à part pour que la GUI
    // puisse retrouver le fichier ~/.claude/sessions/<pid>.json correspondant et
    // en lire le nom de session (renommage auto en « Claude : <nom> »).
    let claude_session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let cwd = payload.get("cwd").and_then(|v| v.as_str()).map(String::from);
    let message = serde_json::json!({
        "session_id": session_id,
        "claude_session_id": claude_session_id,
        "cwd": cwd,
        "event": event,
        "payload": payload,
    });
    let _ = send_to_socket(&message.to_string());
    0
}

fn send_to_socket(msg: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    let path = hooks::socket_path();
    let mut stream = UnixStream::connect(&path)?;
    stream.set_write_timeout(Some(std::time::Duration::from_millis(500)))?;
    stream.write_all(msg.as_bytes())?;
    stream.write_all(b"\n")?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PtyManager::default())
        .setup(|app| {
            hooks::start_hook_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_to_terminal,
            pty::resize_terminal,
            pty::kill_terminal,
            pty::get_pty_pid,
            meta::get_session_metadata,
            meta::get_foreground_process,
            tmux::list_tmux_sessions,
            tmux::tmux_kill_session,
            claude::list_claude_sessions,
            claude::get_claude_session_name,
            download::download_to_downloads,
            config::load_config,
            config::save_config,
            claude_hooks::check_claude_hooks,
            claude_hooks::install_claude_hooks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
