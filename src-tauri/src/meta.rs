use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Clone, Debug, Default)]
pub struct SessionMetadata {
    pub git_branch: Option<String>,
    pub ports: Vec<u16>,
}

#[tauri::command]
pub fn get_session_metadata(cwd: Option<String>, pid: Option<u32>) -> Result<SessionMetadata, String> {
    let mut out = SessionMetadata::default();

    // Préférer le cwd réel du process (suit `cd` dans le shell). Fallback sur
    // le cwd fourni au spawn si le process n'expose pas /proc/<pid>/cwd
    // (process mort, deepest child non lisible).
    let resolved_cwd = pid.and_then(|p| deepest_child_cwd(p)).or(cwd);

    if let Some(d) = resolved_cwd.as_ref() {
        out.git_branch = git_branch(d);
    }

    if let Some(p) = pid {
        out.ports = listening_ports_for_tree(p);
    }

    Ok(out)
}

/// Remonte la chaîne d'enfants depuis `root` pour trouver le process le plus
/// profond et lit son cwd via /proc/<pid>/cwd. Si l'utilisateur fait `cd` dans
/// le shell, c'est ce cwd-là qui reflète vraiment où il est.
fn deepest_child_cwd(root: u32) -> Option<String> {
    let mut current = root;
    // Descendre dans la chaîne d'enfants (linéaire si pas de fork-bomb).
    for _ in 0..16 {
        let children = child_pids(current);
        if children.is_empty() {
            break;
        }
        // En cas de plusieurs enfants, prendre le plus récent (probablement le
        // process foreground).
        current = *children.last().unwrap();
    }
    let link = format!("/proc/{}/cwd", current);
    std::fs::read_link(&link)
        .ok()
        .and_then(|p| p.to_str().map(String::from))
}

fn git_branch(cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", cwd, "branch", "--show-current"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        // Detached HEAD: short SHA fallback.
        let out2 = Command::new("git")
            .args(["-C", cwd, "rev-parse", "--short", "HEAD"])
            .output()
            .ok()?;
        if !out2.status.success() {
            return None;
        }
        let sha = String::from_utf8_lossy(&out2.stdout).trim().to_string();
        return if sha.is_empty() {
            None
        } else {
            Some(format!("({sha})"))
        };
    }
    Some(s)
}

fn child_pids(parent: u32) -> Vec<u32> {
    // /proc/<pid>/task/<tid>/children — kernel >= 3.5
    let path = format!("/proc/{}/task/{}/children", parent, parent);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    content
        .split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

fn all_descendants(root: u32) -> HashSet<u32> {
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for c in child_pids(pid) {
            stack.push(c);
        }
    }
    seen
}

/// Parse /proc/net/tcp and tcp6 to find sockets in LISTEN state owned by any
/// PID in `pids` (resolved via /proc/<pid>/fd inode matching).
fn listening_ports_for_tree(root_pid: u32) -> Vec<u16> {
    let pids = all_descendants(root_pid);
    let mut inodes = HashSet::new();
    for pid in &pids {
        if let Ok(fds) = fs::read_dir(format!("/proc/{}/fd", pid)) {
            for fd in fds.flatten() {
                if let Ok(link) = fs::read_link(fd.path()) {
                    let s = link.to_string_lossy();
                    // e.g. "socket:[123456]"
                    if let Some(rest) = s.strip_prefix("socket:[") {
                        if let Some(inum) = rest.strip_suffix(']') {
                            if let Ok(n) = inum.parse::<u64>() {
                                inodes.insert(n);
                            }
                        }
                    }
                }
            }
        }
    }
    if inodes.is_empty() {
        return vec![];
    }

    let mut ports = HashSet::new();
    for proc_path in &["/proc/net/tcp", "/proc/net/tcp6"] {
        let content = match fs::read_to_string(Path::new(proc_path)) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if i == 0 {
                continue; // header
            }
            // sl  local_address  rem_address  st  ...  inode
            // local_address = HEX_IP:HEX_PORT
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 {
                continue;
            }
            let state = cols[3];
            if state != "0A" {
                continue; // 0A = LISTEN
            }
            let inode: u64 = match cols[9].parse() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if !inodes.contains(&inode) {
                continue;
            }
            let local = cols[1];
            if let Some((_, port_hex)) = local.rsplit_once(':') {
                if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                    ports.insert(port);
                }
            }
        }
    }
    let mut sorted: Vec<u16> = ports.into_iter().collect();
    sorted.sort();
    sorted
}
