use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty, Child};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, Arc<Mutex<PtySession>>>>,
}

#[derive(Serialize, Clone)]
pub struct PtyOutput {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub id: String,
    pub code: Option<u32>,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub id: String,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub command: Option<Vec<String>>,
}

/// Quote un argument pour qu'il soit interprété littéralement par un shell POSIX
/// (sh/bash/zsh). Single-quotes : tout caractère y est littéral, sauf le single
/// quote lui-même qu'on ferme/échappe via la séquence classique `'\''`.
fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, PtyManager>,
    args: SpawnArgs,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = args.shell.unwrap_or_else(|| {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    });

    let mut cmd = if let Some(parts) = args.command.filter(|p| !p.is_empty()) {
        // Une commande explicite (restauration : `claude`, `ssh …`, `tmux attach …`)
        // est exécutée À TRAVERS le shell de login interactif de l'utilisateur, et
        // non directement. Lancée directement, portable-pty ne résout le binaire que
        // dans le PATH minimal hérité du process noobmux (lanceur desktop), qui ne
        // contient ni ~/.local/bin, ni nvm, ni bun… → « claude: No viable candidates
        // found in PATH ». En passant par `$SHELL -lic`, on charge ~/.zshrc et donc
        // le PATH enrichi de l'utilisateur, exactement comme s'il avait tapé la
        // commande à la main dans un terminal noobmux ordinaire.
        let script = parts.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
        // `exec` : remplace le shell wrapper par la commande, pour que le foreground
        // observé via /proc et la mort du process restent ceux de la vraie commande.
        let mut c = CommandBuilder::new(&shell);
        c.arg("-lic");
        c.arg(format!("exec {script}"));
        c
    } else {
        CommandBuilder::new(shell)
    };

    if let Some(cwd) = args.cwd {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("NOOBMUX_SESSION_ID", &args.id);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session = Arc::new(Mutex::new(PtySession {
        master: pair.master,
        writer,
        child,
    }));

    state
        .sessions
        .lock()
        .insert(args.id.clone(), session.clone());

    // Reader thread → forward bytes to frontend.
    let id_for_reader = args.id.clone();
    let app_for_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Octets résiduels d'un caractère UTF-8 multi-octets coupé à la frontière
        // du chunk précédent. On les rejoue en tête du chunk suivant pour ne pas
        // les décoder à moitié (sinon `from_utf8_lossy` les remplace par U+FFFD →
        // box-drawing/accents/emojis corrompus, et toute séquence ANSI scindée
        // est abandonnée par xterm → résidus à l'écran qui ne s'effacent pas).
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut chunk = std::mem::take(&mut carry);
                    chunk.extend_from_slice(&buf[..n]);
                    // Trouver la plus longue tête valide UTF-8 ; garder l'éventuel
                    // caractère incomplet de fin pour la prochaine lecture.
                    let valid_up_to = match std::str::from_utf8(&chunk) {
                        Ok(_) => chunk.len(),
                        Err(e) => {
                            // error_len() == None → octet de tête d'un caractère
                            // tronqué en fin de chunk : on le reporte. Sinon c'est
                            // une vraie séquence invalide au milieu → on la laisse
                            // à from_utf8_lossy (remplacement) et on continue.
                            match e.error_len() {
                                None => e.valid_up_to(),
                                Some(_) => chunk.len(),
                            }
                        }
                    };
                    if valid_up_to < chunk.len() {
                        carry = chunk[valid_up_to..].to_vec();
                        chunk.truncate(valid_up_to);
                    }
                    let data = String::from_utf8_lossy(&chunk).to_string();
                    let _ = app_for_reader.emit(
                        "pty:output",
                        PtyOutput {
                            id: id_for_reader.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Résidu non complété en fin de flux : le rendre tel quel (remplacement)
        // plutôt que de le perdre silencieusement.
        if !carry.is_empty() {
            let _ = app_for_reader.emit(
                "pty:output",
                PtyOutput {
                    id: id_for_reader.clone(),
                    data: String::from_utf8_lossy(&carry).to_string(),
                },
            );
        }
        // Le flux est clos → le process est mort (ou en train de l'être). On
        // retire la session du manager (sinon le HashMap fuit pour toute session
        // terminée par `exit`/crash, jamais via kill_terminal) et on reape le
        // child pour récupérer son code et ne pas laisser de zombie.
        let mgr = app_for_reader.state::<PtyManager>();
        let code = if let Some(session) = mgr.sessions.lock().remove(&id_for_reader) {
            let mut s = session.lock();
            s.child.wait().ok().map(|st| st.exit_code())
        } else {
            None
        };
        let _ = app_for_reader.emit(
            "pty:exit",
            PtyExit {
                id: id_for_reader,
                code,
            },
        );
    });

    Ok(args.id)
}

#[tauri::command]
pub fn write_to_terminal(
    state: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("unknown session")?.clone();
    drop(sessions);
    let mut s = session.lock();
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("unknown session")?.clone();
    drop(sessions);
    let s = session.lock();
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_pty_pid(state: State<'_, PtyManager>, id: String) -> Result<Option<u32>, String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("unknown session")?.clone();
    drop(sessions);
    let s = session.lock();
    Ok(s.child.process_id())
}

#[tauri::command]
pub fn kill_terminal(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock();
    if let Some(session) = sessions.remove(&id) {
        let mut s = session.lock();
        // Tuer tout l'arbre (shell + pnpm dev/node/… lancés dedans), pas juste le
        // shell — sinon les enfants restent orphelins et gardent leur port.
        // child.kill() seul ne propage rien (SIGKILL non catchable côté shell).
        if let Some(pid) = s.child.process_id() {
            crate::meta::kill_process_tree(pid);
        } else {
            let _ = s.child.kill();
        }
        // Reaper le shell pour ne pas laisser de zombie dans la table des process.
        let _ = s.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_simple_arg() {
        assert_eq!(shell_quote("claude"), "'claude'");
    }

    #[test]
    fn quotes_arg_with_spaces() {
        assert_eq!(shell_quote("my session"), "'my session'");
    }

    #[test]
    fn escapes_embedded_single_quote() {
        // l'\''s → ferme la quote, insère un ' échappé, rouvre la quote.
        assert_eq!(shell_quote("l's"), "'l'\\''s'");
    }

    #[test]
    fn neutralizes_shell_metacharacters() {
        // Métacaractères et substitution de commande restent littéraux une fois
        // quotés — pas d'expansion, pas d'injection.
        assert_eq!(shell_quote("a; rm -rf /"), "'a; rm -rf /'");
        assert_eq!(shell_quote("$(whoami)"), "'$(whoami)'");
    }
}
