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

/// Répertoire où Claude Code écrit ses fichiers d'état de session :
/// ~/.claude/sessions/<pid>.json. Chaque fichier contient `sessionId`, `cwd`,
/// `status`, et — si l'utilisateur a nommé la session (/title) — un champ `name`.
fn claude_sessions_dir() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".claude");
    p.push("sessions");
    p
}

/// Renvoie le nom de la session Claude dont l'UUID est `claude_session_id`, en
/// scannant ~/.claude/sessions/*.json et en matchant la clé `sessionId`.
/// `Ok(None)` si la session existe mais n'a pas de nom, ou si on ne la trouve
/// pas (Claude ne crée le champ `name` qu'après un /title). Jamais d'erreur
/// fatale : la GUI appelle ça à chaque hook, un échec ne doit pas casser le flux.
#[tauri::command]
pub fn get_claude_session_name(claude_session_id: String) -> Result<Option<String>, String> {
    find_claude_session_name(&claude_sessions_dir(), &claude_session_id)
}

/// Logique pure (dossier paramétré) derrière get_claude_session_name, pour
/// pouvoir la tester sans dépendre de ~/.claude réel.
fn find_claude_session_name(dir: &PathBuf, claude_session_id: &str) -> Result<Option<String>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sid = parsed.get("sessionId").and_then(|v| v.as_str());
        if sid != Some(claude_session_id) {
            continue;
        }
        let name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        return Ok(name);
    }
    Ok(None)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = env::temp_dir();
        d.push(format!("noobmux-claude-test-{tag}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_session(dir: &PathBuf, pid: &str, json: &str) {
        fs::write(dir.join(format!("{pid}.json")), json).unwrap();
    }

    #[test]
    fn matches_session_id_and_returns_name() {
        let dir = temp_dir("named");
        write_session(
            &dir,
            "523644",
            r#"{"pid":523644,"sessionId":"d9c835ab","cwd":"/x","name":"parser-sandbox-s3-storage"}"#,
        );
        write_session(&dir, "659023", r#"{"pid":659023,"sessionId":"other","cwd":"/y"}"#);
        let got = find_claude_session_name(&dir, "d9c835ab").unwrap();
        assert_eq!(got, Some("parser-sandbox-s3-storage".to_string()));
    }

    #[test]
    fn session_without_name_returns_none() {
        let dir = temp_dir("unnamed");
        write_session(&dir, "1364950", r#"{"pid":1364950,"sessionId":"abc","cwd":"/z"}"#);
        assert_eq!(find_claude_session_name(&dir, "abc").unwrap(), None);
    }

    #[test]
    fn empty_or_whitespace_name_returns_none() {
        let dir = temp_dir("blank");
        write_session(&dir, "1", r#"{"sessionId":"s1","name":"   "}"#);
        assert_eq!(find_claude_session_name(&dir, "s1").unwrap(), None);
    }

    #[test]
    fn unknown_session_id_returns_none() {
        let dir = temp_dir("unknown");
        write_session(&dir, "1", r#"{"sessionId":"s1","name":"foo"}"#);
        assert_eq!(find_claude_session_name(&dir, "nope").unwrap(), None);
    }

    #[test]
    fn missing_dir_returns_none() {
        let mut dir = env::temp_dir();
        dir.push("noobmux-claude-test-does-not-exist");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(find_claude_session_name(&dir, "whatever").unwrap(), None);
    }

    #[test]
    fn ignores_malformed_json_files() {
        let dir = temp_dir("malformed");
        fs::write(dir.join("bad.json"), b"{not json").unwrap();
        write_session(&dir, "2", r#"{"sessionId":"s2","name":"ok"}"#);
        assert_eq!(
            find_claude_session_name(&dir, "s2").unwrap(),
            Some("ok".to_string())
        );
    }
}
