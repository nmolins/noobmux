use serde::Serialize;
use std::process::Command;

#[tauri::command]
pub fn tmux_kill_session(name: String) -> Result<(), String> {
    let status = Command::new("tmux")
        .args(["kill-session", "-t", &name])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("tmux kill-session failed with status {}", status));
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct TmuxSession {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
}

#[tauri::command]
pub fn list_tmux_sessions() -> Result<Vec<TmuxSession>, String> {
    let output = Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_attached}\t#{session_windows}",
        ])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };

    if !output.status.success() {
        // tmux exits non-zero if there's no server running: not an error.
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split('\t');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let attached = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .map(|n| n > 0)
            .unwrap_or(false);
        let windows = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
        sessions.push(TmuxSession {
            name,
            attached,
            windows,
        });
    }
    Ok(sessions)
}
