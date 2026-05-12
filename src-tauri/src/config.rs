use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn config_dir() -> Result<PathBuf, String> {
    let mut p = dirs::config_dir().ok_or("no config dir")?;
    p.push("noobmux");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

#[tauri::command]
pub fn load_config() -> Result<serde_json::Value, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_config(config: serde_json::Value) -> Result<(), String> {
    let path = config_path()?;
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(serialized.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
