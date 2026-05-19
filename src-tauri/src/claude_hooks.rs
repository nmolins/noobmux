// Gestion des hooks Claude Code dans ~/.claude/settings.json.
// On installe des hooks qui pointent vers `<noobmux-exe> --hook <event>` pour
// que Claude nous notifie de UserPromptSubmit/PreToolUse/Stop/Notification.

use serde_json::{json, Value};
use std::path::PathBuf;

const EVENTS: &[&str] = &["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification"];

fn settings_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".claude").join("settings.json"))
}

fn current_exe() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
}

fn read_settings(path: &PathBuf) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Vrai si tous nos hooks pointent déjà vers l'exécutable courant.
fn hooks_match(settings: &Value, exe: &str) -> bool {
    let hooks = match settings.get("hooks").and_then(|h| h.as_object()) {
        Some(h) => h,
        None => return false,
    };
    for event in EVENTS {
        let expected_cmd = format!("{} --hook {}", exe, event);
        let found = hooks
            .get(*event)
            .and_then(|arr| arr.as_array())
            .map(|arr| {
                arr.iter().any(|matcher| {
                    matcher
                        .get("hooks")
                        .and_then(|h| h.as_array())
                        .map(|inner| {
                            inner.iter().any(|h| {
                                h.get("command").and_then(|c| c.as_str()) == Some(&expected_cmd)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !found {
            return false;
        }
    }
    true
}

#[derive(serde::Serialize)]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub current_exe: String,
}

#[tauri::command]
pub fn check_claude_hooks() -> Result<HookStatus, String> {
    let path = settings_path().ok_or("Impossible de trouver ~/.claude/settings.json")?;
    let exe = current_exe().ok_or("Impossible de déterminer le chemin du binaire noobmux")?;
    let settings = read_settings(&path);
    Ok(HookStatus {
        installed: hooks_match(&settings, &exe),
        settings_path: path.to_string_lossy().into_owned(),
        current_exe: exe,
    })
}

#[tauri::command]
pub fn install_claude_hooks() -> Result<HookStatus, String> {
    let path = settings_path().ok_or("Impossible de trouver ~/.claude/settings.json")?;
    let exe = current_exe().ok_or("Impossible de déterminer le chemin du binaire noobmux")?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }

    let mut settings = read_settings(&path);
    if !settings.is_object() {
        settings = json!({});
    }
    let root = settings.as_object_mut().unwrap();
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("hooks n'est pas un objet")?;

    for event in EVENTS {
        let cmd = format!("{} --hook {}", exe, event);
        // Liste existante pour cet event (ou nouvelle).
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event} n'est pas un array"))?;

        // Retirer toute entrée noobmux préexistante (autre chemin d'exé) pour
        // éviter les doublons quand l'utilisateur a réinstallé noobmux ailleurs.
        arr.retain(|matcher| {
            let inner = match matcher.get("hooks").and_then(|h| h.as_array()) {
                Some(a) => a,
                None => return true,
            };
            !inner.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("noobmux") && c.contains("--hook"))
                    .unwrap_or(false)
            })
        });

        // Ajouter notre matcher.
        arr.push(json!({
            "hooks": [{ "type": "command", "command": cmd }]
        }));
    }

    let serialized =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, serialized).map_err(|e| format!("write: {e}"))?;

    Ok(HookStatus {
        installed: true,
        settings_path: path.to_string_lossy().into_owned(),
        current_exe: exe,
    })
}
