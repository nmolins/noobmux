use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

#[tauri::command]
pub async fn download_to_downloads(url: String, filename: String) -> Result<String, String> {
    // Sécurité : on n'autorise QUE le domaine de notre repo pour éviter qu'un
    // latest.json corrompu pointe vers du malware.
    if !url.starts_with("https://github.com/nmolins/noobmux/releases/") {
        return Err(format!("URL not allowed: {url}"));
    }
    let target = downloads_dir().ok_or("no downloads dir")?.join(&filename);

    let client = reqwest::Client::builder()
        .user_agent("noobmux-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut file = tokio::fs::File::create(&target)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;

    Ok(target.to_string_lossy().to_string())
}

fn downloads_dir() -> Option<PathBuf> {
    dirs::download_dir().or_else(dirs::home_dir)
}
