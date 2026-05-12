import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  notes?: string | null;
  apply: () => Promise<void>;
}

let bannerEl: HTMLDivElement | null = null;
let checking = false;

/**
 * Vérifie s'il y a une mise à jour. Retourne info + apply si oui, null sinon.
 * `silent` = ne pas alerter en cas d'erreur (utilisé au boot).
 */
export async function checkForUpdate(opts?: { silent?: boolean }): Promise<UpdateInfo | null> {
  if (checking) return null;
  checking = true;
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body,
      apply: async () => {
        await update.downloadAndInstall();
        await relaunch();
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
    <button class="update-banner-apply">Installer</button>
    <button class="update-banner-dismiss" title="Plus tard">×</button>
  `;
  const applyBtn = bannerEl.querySelector(".update-banner-apply") as HTMLButtonElement;
  const dismissBtn = bannerEl.querySelector(".update-banner-dismiss") as HTMLButtonElement;
  applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = "Téléchargement…";
    try {
      await info.apply();
    } catch (e) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Installer";
      alert(`Échec de la mise à jour : ${e}`);
    }
  });
  dismissBtn.addEventListener("click", () => {
    bannerEl?.remove();
    bannerEl = null;
  });
  document.body.appendChild(bannerEl);
}
