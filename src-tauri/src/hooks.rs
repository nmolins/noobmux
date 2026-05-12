use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixListener;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentEvent {
    pub session_id: Option<String>,
    pub event: String,
    pub payload: serde_json::Value,
}

pub fn socket_path() -> PathBuf {
    let mut p = dirs::runtime_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir);
    p.push("noobmux.sock");
    p
}

pub fn start_hook_listener(app: AppHandle) {
    let path = socket_path();
    let _ = std::fs::remove_file(&path);

    tauri::async_runtime::spawn(async move {
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("noobmux: failed to bind hook socket: {e}");
                return;
            }
        };
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    if let Ok(evt) = serde_json::from_str::<AgentEvent>(line.trim()) {
                        let _ = app.emit("agent:event", evt);
                    }
                    line.clear();
                }
            });
        }
    });
}
