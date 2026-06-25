// Panneau latéral de visualisation des screenshots produits par Claude Code
// (outils de test navigateur). Suit la session active : interroge le backend
// pour le cwd courant, affiche les vignettes, signale les nouveaux via un badge,
// et propose une lightbox interne + ouverture dans le visionneur système.

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { getConfig, updateUI } from "./store";

interface Screenshot {
  path: string;
  name: string;
  modified_ms: number;
  size: number;
}

// Cache des data-URL déjà chargées (clé = path), pour ne pas relire le fichier à
// chaque rendu. Invalidé pour un path si son mtime change (rare : même nom réécrit).
const dataUrlCache = new Map<string, { mtime: number; url: string }>();

// État courant.
let currentCwd: string | null = null;
let currentShots: Screenshot[] = [];
let lastSeenPaths = new Set<string>(); // pour calculer le delta « nouveaux »
let unseenCount = 0; // badge : nb de nouveaux non encore vus (panneau fermé)
let lightboxIndex = -1;

// Éléments DOM (résolus au setup).
let panel: HTMLElement;
let resizer: HTMLElement;
let toggleBtn: HTMLElement;
let badge: HTMLElement;
let grid: HTMLElement;
let countEl: HTMLElement;
let refreshBtn: HTMLElement;
let lightbox: HTMLElement;
let lightboxImg: HTMLImageElement;
let lightboxName: HTMLElement;

function isOpen(): boolean {
  return !panel.classList.contains("collapsed");
}

async function loadDataUrl(shot: Screenshot): Promise<string> {
  const cached = dataUrlCache.get(shot.path);
  if (cached && cached.mtime === shot.modified_ms) return cached.url;
  const url = await invoke<string>("read_screenshot", { path: shot.path });
  dataUrlCache.set(shot.path, { mtime: shot.modified_ms, url });
  return url;
}

// Rend la grille de vignettes. Les images sont chargées en lazy (Intersection
// Observer) pour ne pas décoder 30 PNG d'un coup à l'ouverture.
function renderGrid() {
  countEl.textContent = currentShots.length ? String(currentShots.length) : "";
  grid.innerHTML = "";
  if (currentShots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "shots-empty";
    empty.textContent = "Aucun screenshot pour cette session.";
    grid.appendChild(empty);
    return;
  }
  currentShots.forEach((shot, i) => {
    const cell = document.createElement("button");
    cell.className = "shot-cell";
    cell.title = shot.name;
    const img = document.createElement("img");
    img.className = "shot-thumb";
    img.alt = shot.name;
    img.loading = "lazy";
    img.dataset.path = shot.path;
    const label = document.createElement("span");
    label.className = "shot-name";
    label.textContent = shot.name;
    cell.appendChild(img);
    cell.appendChild(label);
    cell.addEventListener("click", () => openLightbox(i));
    grid.appendChild(cell);
    thumbObserver.observe(img);
  });
}

// Charge la data-URL d'une vignette quand elle entre dans le viewport.
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target as HTMLImageElement;
      thumbObserver.unobserve(img);
      const path = img.dataset.path!;
      const shot = currentShots.find((s) => s.path === path);
      if (!shot) continue;
      loadDataUrl(shot)
        .then((url) => (img.src = url))
        .catch((err) => console.warn("[shots] thumb load failed", err));
    }
  },
  { root: null, rootMargin: "200px" }
);

function updateBadge() {
  if (unseenCount > 0 && !isOpen()) {
    badge.textContent = String(unseenCount);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// Interroge le backend pour le cwd courant et met à jour l'état. Calcule le delta
// de nouveaux fichiers pour le badge. Appelé en boucle (poll) et au refresh.
async function refresh() {
  const cwd = currentCwd;
  let shots: Screenshot[] = [];
  if (cwd) {
    try {
      shots = await invoke<Screenshot[]>("list_screenshots", { cwd });
    } catch (err) {
      console.warn("[shots] list_screenshots failed", err);
    }
  }
  // Détecter les nouveaux paths vs ce qu'on avait déjà listé.
  const newPaths = shots.filter((s) => !lastSeenPaths.has(s.path));
  if (newPaths.length > 0 && !isOpen()) {
    unseenCount += newPaths.length;
  }
  lastSeenPaths = new Set(shots.map((s) => s.path));
  currentShots = shots;
  if (isOpen()) {
    unseenCount = 0;
    renderGrid();
  }
  updateBadge();
}

// Appelé par main.ts quand la session active change. Réinitialise l'état pour
// la nouvelle session (le badge ne reporte pas les nouveaux d'une autre session).
export function setActiveCwd(cwd: string | null) {
  if (cwd === currentCwd) return;
  currentCwd = cwd;
  lastSeenPaths = new Set();
  unseenCount = 0;
  currentShots = [];
  void refresh();
}

function setOpen(open: boolean) {
  panel.classList.toggle("collapsed", !open);
  resizer.classList.toggle("hidden", !open);
  if (open) {
    panel.style.width = `${getConfig().ui.shotsPanelWidth}px`;
    unseenCount = 0;
    renderGrid();
    void refresh();
  } else {
    panel.style.width = "";
  }
  updateBadge();
  updateUI({ shotsPanelOpen: open });
}

// ─── Lightbox ──────────────────────────────────────────────────────────────

async function showLightboxImage() {
  const shot = currentShots[lightboxIndex];
  if (!shot) return;
  lightboxName.textContent = shot.name;
  try {
    lightboxImg.src = await loadDataUrl(shot);
  } catch (err) {
    console.warn("[shots] lightbox load failed", err);
  }
}

function openLightbox(index: number) {
  lightboxIndex = index;
  lightbox.classList.remove("hidden");
  void showLightboxImage();
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
  lightboxIndex = -1;
}

function navLightbox(delta: number) {
  if (lightboxIndex < 0 || currentShots.length === 0) return;
  lightboxIndex =
    (lightboxIndex + delta + currentShots.length) % currentShots.length;
  void showLightboxImage();
}

async function openInSystem() {
  const shot = currentShots[lightboxIndex];
  if (!shot) return;
  try {
    await openPath(shot.path);
  } catch (err) {
    console.warn("[shots] openPath failed", err);
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────

export function setupScreenshotsPanel() {
  panel = document.getElementById("shots-panel")!;
  resizer = document.getElementById("shots-resizer")!;
  toggleBtn = document.getElementById("shots-toggle")!;
  badge = document.getElementById("shots-badge")!;
  grid = document.getElementById("shots-grid")!;
  countEl = document.getElementById("shots-count")!;
  refreshBtn = document.getElementById("shots-refresh")!;
  lightbox = document.getElementById("shots-lightbox")!;
  lightboxImg = document.getElementById("lightbox-img") as HTMLImageElement;
  lightboxName = document.getElementById("lightbox-name")!;

  toggleBtn.addEventListener("click", () => setOpen(!isOpen()));
  refreshBtn.addEventListener("click", () => {
    unseenCount = 0;
    void refresh();
  });

  document.getElementById("lightbox-close")!.addEventListener("click", closeLightbox);
  document.getElementById("lightbox-prev")!.addEventListener("click", () => navLightbox(-1));
  document.getElementById("lightbox-next")!.addEventListener("click", () => navLightbox(1));
  document
    .getElementById("lightbox-open-system")!
    .addEventListener("click", openInSystem);
  // Clic sur le fond (hors image/boutons) ferme la lightbox.
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  // Raccourcis lightbox : Échap ferme, flèches naviguent.
  window.addEventListener("keydown", (e) => {
    if (lightbox.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      navLightbox(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navLightbox(1);
    }
  });

  setupResizer();

  // Restaurer l'état persisté (déplié + largeur).
  if (getConfig().ui.shotsPanelOpen) setOpen(true);
}

function setupResizer() {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // Le panneau est à DROITE : élargir quand on glisse vers la gauche.
    const w = Math.max(180, Math.min(640, startWidth - (e.clientX - startX)));
    panel.style.width = `${w}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    updateUI({ shotsPanelWidth: Math.round(panel.getBoundingClientRect().width) });
  });
}

// Démarre le poll périodique. Appelé une fois au boot par main.ts.
export function startScreenshotsPolling(intervalMs = 2000) {
  setInterval(() => void refresh(), intervalMs);
}
