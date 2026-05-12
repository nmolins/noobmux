mod claude;
mod config;
mod download;
mod hooks;
mod meta;
mod pty;
mod tmux;

use pty::PtyManager;

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
            tmux::list_tmux_sessions,
            tmux::tmux_kill_session,
            claude::list_claude_sessions,
            download::download_to_downloads,
            config::load_config,
            config::save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
