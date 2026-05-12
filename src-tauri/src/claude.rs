use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeSession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub project_dir: Option<String>,
    /** Secondes depuis la dernière mise à jour de la statusline. */
    pub age_seconds: f64,
}

fn sessions_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("noobmux");
    p.push("sessions");
    p
}

#[tauri::command]
pub fn list_claude_sessions() -> Result<Vec<ClaudeSession>, String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let now = SystemTime::now();
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let age = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(f64::INFINITY);

        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let session_id = parsed
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let session_id = match session_id {
            Some(id) => id,
            None => continue,
        };
        let cwd = parsed.get("cwd").and_then(|v| v.as_str()).map(String::from);
        let model = parsed
            .get("model")
            .and_then(|m| m.get("display_name"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let project_dir = parsed
            .get("workspace")
            .and_then(|w| w.get("project_dir"))
            .and_then(|v| v.as_str())
            .map(String::from);

        out.push(ClaudeSession {
            session_id,
            cwd,
            model,
            project_dir,
            age_seconds: age,
        });
    }
    // Trier par fraîcheur (plus récent d'abord).
    out.sort_by(|a, b| a.age_seconds.partial_cmp(&b.age_seconds).unwrap());
    Ok(out)
}
