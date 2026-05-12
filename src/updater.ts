import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

export interface UpdateInfo {
  version: string;
  notes?: string | null;
  /**
   * Télécharge le .deb dans ~/Downloads puis ouvre le fichier via le
   * gestionnaire système. L'utilisateur installe manuellement (sudo prompt
   * via apt/Software Center). On évite ainsi le problème de droits root
   * de l'updater Tauri natif.
   */
  downloadAndOpen: () => Promise<string>;
}

let bannerEl: HTMLDivElement | null = null;
let checking = false;

export async function checkForUpdate(opts?: { silent?: boolean }): Promise<UpdateInfo | null> {
  if (checking) return null;
  checking = true;
  try {
    const update = await check();
    if (!update) return null;

    const rawJson = update.rawJson as any;
    const url = rawJson?.platforms?.["linux-x86_64"]?.url as string | undefined;
    if (!url) {
      if (!opts?.silent) alert("Mise à jour disponible mais URL introuvable dans latest.json");
      return null;
    }
    const filename = url.split("/").pop() ?? `noobmux_${update.version}_amd64.deb`;

    return {
      version: update.version,
      notes: update.body,
      downloadAndOpen: async () => {
        const path = await invoke<string>("download_to_downloads", { url, filename });
        await openPath(path);
        return path;
      },
    };
  } catch (e) {
    if (!opts?.silent) {
      console.error("[noobmux updater]", e);
      alert(`Vérification des mises à jour : ${e}`);
    }
    return null;
  } finally {
    checking = false;
  }
}

export function showUpdateBanner(info: UpdateInfo) {
  if (bannerEl) return;
  bannerEl = document.createElement("div");
  bannerEl.className = "update-banner";
  bannerEl.innerHTML = `
    <div class="update-banner-text">
      Mise à jour disponible <strong>v${info.version}</strong>
    </div>
    <button class="update-banner-apply">Télécharger</button>
    <button class="update-banner-dismiss" title="Plus tard">×</button>
  `;
  const applyBtn = bannerEl.querySelector(".update-banner-apply") as HTMLButtonElement;
  const dismissBtn = bannerEl.querySelector(".update-banner-dismiss") as HTMLButtonElement;
  applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = "Téléchargement…";
    try {
      const path = await info.downloadAndOpen();
      applyBtn.textContent = "Téléchargé";
      const text = bannerEl?.querySelector(".update-banner-text") as HTMLDivElement;
      if (text) {
        text.innerHTML = `Téléchargé dans <code>${escapeHtml(path)}</code>. Installe via le gestionnaire de paquets pour appliquer.`;
      }
    } catch (e) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Télécharger";
      alert(`Échec du téléchargement : ${e}`);
    }
  });
  dismissBtn.addEventListener("click", () => {
    bannerEl?.remove();
    bannerEl = null;
  });
  document.body.appendChild(bannerEl);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
