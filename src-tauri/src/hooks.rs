use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::UnixListener;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentEvent {
    pub session_id: Option<String>,
    /// UUID de la session Claude (extrait du payload du hook), pour matcher le
    /// fichier ~/.claude/sessions/<pid>.json et en lire le nom.
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// Répertoire de travail de la session Claude (depuis le payload).
    #[serde(default)]
    pub cwd: Option<String>,
    pub event: String,
    pub payload: serde_json::Value,
}

/// Limite de lecture par connexion.
/// L'émetteur ouvre une nouvelle connexion par event ; cette limite s'applique
/// donc à un seul message. Un payload de hook normal est bien en dessous de
/// 64 KiB. Si un émetteur tiers envoie plus de données sans saut de ligne,
/// la lecture s'arrête ici — protège contre un DoS mémoire local.
const MAX_MSG_BYTES: u64 = 64 * 1024; // 64 KiB

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
        // Restreindre le socket au seul propriétaire : empêche un autre process
        // local d'injecter de faux events si le socket atterrit dans un répertoire
        // de fallback partagé (cache/temp) plutôt que dans XDG_RUNTIME_DIR (0700).
        // Le let _ = est intentionnel : un échec ne doit pas empêcher le démarrage.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Contrat de protocole : un message = une ligne JSON compacte
                // terminée par `\n`, ≤ 64 KiB. Un message plus gros ou
                // contenant un `\n` interne est tronqué/ignoré silencieusement.
                // take(MAX_MSG_BYTES) borne la lecture sur toute la connexion ;
                // acceptable car l'émetteur ouvre une nouvelle connexion par event.
                let mut reader = BufReader::new(stream.take(MAX_MSG_BYTES));
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
