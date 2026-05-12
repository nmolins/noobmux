use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty, Child};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
        let mut c = CommandBuilder::new(&parts[0]);
        for arg in &parts[1..] {
            c.arg(arg);
        }
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
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
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
        let _ = app_for_reader.emit(
            "pty:exit",
            PtyExit {
                id: id_for_reader,
                code: None,
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
        let _ = s.child.kill();
    }
    Ok(())
}
