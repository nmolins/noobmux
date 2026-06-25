//! Découverte et lecture des screenshots produits par Claude Code (outils de
//! test navigateur : dev-browser, chrome-devtools…).
//!
//! Claude écrit ses fichiers de travail dans un répertoire temporaire de session
//! de la forme `/tmp/claude-<uid>/<projet-encodé>/<session-uuid>/scratchpad/…`,
//! où `<projet-encodé>` est le cwd dont chaque caractère non alphanumérique est
//! remplacé par `-` (même schéma que `~/.claude/projects/`). Les screenshots
//! atterrissent typiquement sous `scratchpad/shots/`, mais l'emplacement exact
//! n'est pas une API documentée — on scanne donc TOUT le sous-arbre du projet à
//! la recherche d'images, ce qui résiste à un changement de structure interne.
//!
//! Ce répertoire est volontairement dans /tmp (jetable, nettoyé au reboot) :
//! ce sont des captures de test, pas des artefacts à conserver.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct Screenshot {
    /// Chemin absolu du fichier (sert de clé et d'argument à read_screenshot).
    pub path: String,
    /// Nom de fichier seul, pour l'affichage (ex. "03-tablet-dashboard.png").
    pub name: String,
    /// Date de dernière modification en millisecondes epoch (tri côté UI).
    pub modified_ms: u64,
    /// Taille en octets.
    pub size: u64,
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// Racine des répertoires de session Claude pour l'utilisateur courant.
/// `/tmp/claude-<uid>`. Isolée pour servir aussi de garde-fou anti-traversée.
fn claude_tmp_root() -> PathBuf {
    // SAFETY: geteuid est toujours disponible et sans effet de bord.
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!("/tmp/claude-{uid}"))
}

/// Encode un cwd absolu en nom de dossier projet, à la manière de Claude Code :
/// chaque caractère non `[A-Za-z0-9]` devient `-`. Ex. `/home/nico/Dev/pat`
/// → `-home-nico-Dev-pat`.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Collecte récursivement les images d'un répertoire (profondeur bornée pour
/// éviter de partir en vrille sur un arbre inattendu).
fn collect_images(dir: &Path, depth: u32, out: &mut Vec<Screenshot>) {
    if depth > 6 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_images(&path, depth + 1, out);
            continue;
        }
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(Screenshot {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            modified_ms,
            size: meta.len(),
        });
    }
}

/// Liste les screenshots de la session Claude associée à un cwd donné, triés du
/// plus récent au plus ancien. Renvoie une liste vide (jamais une erreur) si le
/// répertoire de session n'existe pas — cas normal pour une session non-Claude
/// ou sans capture.
#[tauri::command]
pub fn list_screenshots(cwd: Option<String>) -> Result<Vec<Screenshot>, String> {
    let cwd = match cwd {
        Some(c) if !c.is_empty() => c,
        _ => return Ok(vec![]),
    };
    let project_dir = claude_tmp_root().join(encode_project_dir(&cwd));
    if !project_dir.is_dir() {
        return Ok(vec![]);
    }
    let mut shots = Vec::new();
    collect_images(&project_dir, 0, &mut shots);
    shots.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(shots)
}

/// Lit un screenshot et le renvoie en data-URL base64 (`data:image/png;base64,…`)
/// pour affichage direct dans une balise <img> du webview, sans avoir à exposer
/// /tmp via un protocole d'asset.
///
/// Garde-fou : refuse tout chemin hors de `/tmp/claude-<uid>/` (anti-traversée).
#[tauri::command]
pub fn read_screenshot(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    // Canonicalise pour neutraliser les `..` puis vérifie l'appartenance à la
    // racine de session. canonicalize échoue si le fichier n'existe pas → erreur.
    let canon = fs::canonicalize(&p).map_err(|e| format!("chemin invalide: {e}"))?;
    let root = claude_tmp_root();
    if !canon.starts_with(&root) {
        return Err("chemin hors du répertoire de session Claude".into());
    }
    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return Err("type de fichier non supporté".into()),
    };
    let bytes = fs::read(&canon).map_err(|e| format!("lecture impossible: {e}"))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_project_dir_replaces_non_alnum() {
        assert_eq!(encode_project_dir("/home/nico/Dev/pat"), "-home-nico-Dev-pat");
    }

    #[test]
    fn encode_project_dir_preserves_dashes_in_name() {
        // onwatch-menubar : le tiret du nom reste un tiret (comme le / encodé).
        assert_eq!(
            encode_project_dir("/home/nico/Dev/onwatch-menubar"),
            "-home-nico-Dev-onwatch-menubar"
        );
    }

    #[test]
    fn encode_project_dir_handles_dots_and_underscores() {
        assert_eq!(encode_project_dir("/a/b.c/d_e"), "-a-b-c-d-e");
    }

    #[test]
    fn list_screenshots_empty_cwd_returns_empty() {
        assert_eq!(list_screenshots(None).unwrap().len(), 0);
        assert_eq!(list_screenshots(Some(String::new())).unwrap().len(), 0);
    }

    #[test]
    fn list_screenshots_missing_dir_returns_empty() {
        let shots = list_screenshots(Some("/nonexistent/project/xyz".into())).unwrap();
        assert!(shots.is_empty());
    }

    #[test]
    fn read_screenshot_rejects_path_outside_root() {
        // /etc/hostname existe mais est hors de la racine de session → refus.
        let err = read_screenshot("/etc/hostname".into()).unwrap_err();
        assert!(err.contains("hors du répertoire") || err.contains("non supporté"));
    }
}
