import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { v4 as uuid } from "uuid";

import {
  Session,
  SessionKind,
  SessionStatus,
  createSession,
} from "./session";
import { showContextMenu } from "./contextMenu";
import {
  addSection,
  getConfig,
  loadConfig,
  removeSection,
  renameSection,
  renameSessionMeta,
  removeSessionMeta,
  scheduleSave,
  setSessionOrder,
  setSessionsToRestore,
  toggleSection,
  updateUI,
  upsertSessionMeta,
  type SessionRestore,
  type SshProfile,
} from "./store";
import {
  detectClaudeStatusFromScreen,
  detectOscNotifications,
  detectTmuxSession,
  looksLikeClaude,
} from "./detect";
import { promptText } from "./prompt";
import { openSettingsModal } from "./settingsModal";
import { applyThemeToRoot, getTheme } from "./themes";
import { checkForUpdate, showUpdateBanner } from "./updater";

const LAST_DIR_KEY = "noobmux:lastDir";

const sessions = new Map<string, Session>();
// Sessions dont la fermeture est pilotée par l'utilisateur (closeSession a déjà
// fait/va faire le teardown). Le handler pty:exit consécutif au kill ne doit pas
// re-traiter ces sessions comme « process mort tout seul ».
const closing = new Set<string>();
// Sessions dont le process est mort (pty:exit reçu) mais qu'on garde affichées
// en « done »/« error ». Leur PTY n'existe plus côté Rust → exclues des polls de
// statut, qui sinon écraseraient l'état figé.
const exited = new Set<string>();
let activeId: string | null = null;
type PinSide = "right" | "bottom";
let pinnedId: string | null = null;
let pinSide: PinSide = "right";
let splitRatio = 0.5; // proportion du pane principal (0.2..0.8)
let renamingId: string | null = null;
let renamingSectionId: string | null = null;
let attachedTmux = new Set<string>(); // noms tmux qu'on a déjà attachés dans noobmux
let tmuxAvailable: { name: string; windows: number }[] = [];

const sectionListEl = document.getElementById("section-list") as HTMLDivElement;
const terminalsRoot = document.getElementById("terminals") as HTMLDivElement;

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderEmptyState() {
  terminalsRoot.querySelector(".empty-state")?.remove();
  if (sessions.size === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.innerHTML = `<div>Aucun terminal</div><div style="font-size:11px">Clique <b>+ Term</b>, <b>+ Claude</b> ou attache une session tmux dans la sidebar.</div>`;
    terminalsRoot.appendChild(el);
  }
}

function sessionsBySection(sectionId: string): Session[] {
  const cfg = getConfig();
  const order = cfg.sessionOrder;
  const idsForSection: Session[] = [];
  const seen = new Set<string>();
  // Respect saved order first.
  for (const name of order) {
    for (const s of sessions.values()) {
      if (seen.has(s.id)) continue;
      if (s.name !== name) continue;
      const sec = (cfg.sessionMeta[s.name]?.sectionId) ?? "default";
      if (sec === sectionId) {
        idsForSection.push(s);
        seen.add(s.id);
      }
    }
  }
  for (const s of sessions.values()) {
    if (seen.has(s.id)) continue;
    const sec = (cfg.sessionMeta[s.name]?.sectionId) ?? "default";
    if (sec === sectionId) idsForSection.push(s);
  }
  return idsForSection;
}

function renderSidebar() {
  if (renamingId || renamingSectionId) {
    updateSidebarInPlace();
    return;
  }
  sectionListEl.innerHTML = "";
  const cfg = getConfig();
  for (const sec of cfg.sections) {
    const secEl = document.createElement("div");
    secEl.className = "section" + (sec.collapsed ? " collapsed" : "");
    secEl.dataset.sectionId = sec.id;

    const header = document.createElement("div");
    header.className = "section-header";
    header.innerHTML = `
      <span class="caret">▾</span>
      <span class="section-name">${escapeHtml(sec.name)}</span>
      <span class="section-count"></span>
    `;
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("section-name")) return;
      toggleSection(sec.id);
      renderSidebar();
    });
    header.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (sec.builtin) return;
      beginSectionRename(secEl, sec.id);
    });
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (sec.builtin) return;
      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        onRename: () => beginSectionRename(secEl, sec.id),
        onClose: sec.id === "default" ? undefined : () => {
          removeSection(sec.id);
          renderSidebar();
        },
      });
    });
    secEl.appendChild(header);

    const ul = document.createElement("ul");
    ul.className = "session-list";
    ul.dataset.sectionId = sec.id;

    // Drop wiring : tout le .section accepte le drop, sauf le builtin tmux.
    // On utilise un compteur enter/leave pour éviter le flicker quand on
    // traverse des éléments enfants (qui re-déclenchent enter/leave).
    let dragDepth = 0;
    let expandTimer: number | null = null;
    if (sec.builtin !== "tmux") {
      secEl.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes("text/noobmux-session")) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      });
      secEl.addEventListener("dragenter", (e) => {
        if (!e.dataTransfer?.types.includes("text/noobmux-session")) return;
        e.preventDefault();
        dragDepth++;
        secEl.classList.add("drop-target");
        if (sec.collapsed && expandTimer === null) {
          expandTimer = window.setTimeout(() => {
            toggleSection(sec.id);
            renderSidebar();
            expandTimer = null;
          }, 500);
        }
      });
      secEl.addEventListener("dragleave", () => {
        dragDepth--;
        if (dragDepth <= 0) {
          dragDepth = 0;
          secEl.classList.remove("drop-target");
          if (expandTimer !== null) {
            clearTimeout(expandTimer);
            expandTimer = null;
          }
        }
      });
      secEl.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        secEl.classList.remove("drop-target");
        if (expandTimer !== null) {
          clearTimeout(expandTimer);
          expandTimer = null;
        }
        const sid = e.dataTransfer?.getData("text/noobmux-session");
        if (!sid) return;
        moveSessionToSection(sid, sec.id);
      });
    }

    if (sec.builtin === "tmux") {
      // Built-in: liste live des sessions tmux non attachées (et pas déjà ouvertes ici).
      const available = tmuxAvailable.filter((t) => !attachedTmux.has(t.name));
      if (available.length === 0) {
        const empty = document.createElement("li");
        empty.className = "session-empty";
        empty.textContent = "Aucune session tmux";
        ul.appendChild(empty);
      } else {
        for (const t of available) ul.appendChild(buildTmuxItem(t));
      }
      (header.querySelector(".section-count") as HTMLSpanElement).textContent =
        String(available.length);
    } else {
      const items = sessionsBySection(sec.id);
      for (const s of items) ul.appendChild(buildSessionItem(s));
      (header.querySelector(".section-count") as HTMLSpanElement).textContent =
        String(items.length);
    }

    secEl.appendChild(ul);
    sectionListEl.appendChild(secEl);
  }
}

function badgesHtml(s: Session): string {
  const tmuxName = (s as any).tmuxName as string | undefined;
  const isSsh = s.kind === "shell" && isSshComm(sessionMetaCache.get(s.id)?.foregroundComm);
  return [
    s.kind === "agent"
      ? `<span class="session-kind kind-ai">AI</span>`
      : `<span class="session-kind kind-sh">sh</span>`,
    isSsh
      ? `<span class="session-kind kind-ssh" title="Connexion SSH/mosh active">ssh</span>`
      : "",
    tmuxName
      ? `<span class="session-kind kind-tmux" title="tmux:${escapeHtml(tmuxName)}">tmux</span>`
      : "",
  ].join("");
}

function metaLineHtml(s: Session): string {
  const rt = sessionMetaCache.get(s.id);
  const metaParts: string[] = [];
  if (rt?.gitBranch) {
    metaParts.push(`<span class="meta-git" title="Branche git">⎇ ${escapeHtml(rt.gitBranch)}</span>`);
  }
  if (rt?.ports && rt.ports.length > 0) {
    metaParts.push(
      `<span class="meta-ports" title="Ports en écoute">:${rt.ports.slice(0, 3).join(", :")}${rt.ports.length > 3 ? "…" : ""}</span>`
    );
  }
  return metaParts.length > 0 ? `<div class="session-meta">${metaParts.join("")}</div>` : "";
}

function buildSessionItem(s: Session): HTMLLIElement {
  const cfg = getConfig();
  const meta = cfg.sessionMeta[s.name];
  const color = meta?.color || null;

  const li = document.createElement("li");
  li.className =
    "session-item" +
    (s.kind === "agent" ? " kind-agent" : " kind-shell") +
    (s.id === activeId ? " active" : "") +
    (s.status === "waiting" ? " notif-waiting" : "");
  li.dataset.sessionId = s.id;
  li.draggable = true;
  if (color) li.style.setProperty("--session-color", color);

  const badges = badgesHtml(s);
  const metaLine = metaLineHtml(s);

  li.innerHTML = `
    <div class="session-row">
      <span class="status-dot ${s.status}"></span>
      <span class="session-name">${escapeHtml(displayName(s))}</span>
      <span class="session-badges">${badges}</span>
    </div>
    ${metaLine}
  `;

  li.addEventListener("click", () => {
    if (renamingId === s.id) return;
    activate(s.id);
  });

  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // Ne pas changer le pane principal si on clique sur l'épinglé.
    if (s.id !== pinnedId) activate(s.id);
    const cfg = getConfig();
    const currentSection = cfg.sessionMeta[s.name]?.sectionId ?? "default";
    const tmuxName = (s as any).tmuxName as string | undefined;
    showContextMenu({
      x: e.clientX,
      y: e.clientY,
      closeLabel: tmuxName ? "Détacher tmux" : "Fermer",
      onRun: (cmd) => runInSession(s.id, cmd + "\n"),
      onRename: () => beginRenameById(s.id),
      onPin: s.id === pinnedId ? undefined : sessions.size >= 2 ? (side) => pinSession(s.id, side) : undefined,
      onUnpin: s.id === pinnedId ? () => unpin() : undefined,
      onClose: () => closeSession(s.id),
      onKillTmux: tmuxName ? () => closeSession(s.id, { killTmux: true }) : undefined,
      onColor: (hex) => {
        upsertSessionMeta(s.name, { color: hex });
        renderSidebar();
      },
      onMoveTo: (sid) => moveSessionToSection(s.id, sid),
      sectionChoices: cfg.sections
        .filter((sec) => !sec.builtin)
        .map((sec) => ({
          id: sec.id,
          name: sec.name,
          current: sec.id === currentSection,
        })),
    });
  });

  li.addEventListener("dblclick", (e) => {
    e.preventDefault();
    beginRenameById(s.id);
  });

  li.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/noobmux-session", s.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  return li;
}

function buildTmuxItem(t: { name: string; windows: number }): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "session-item tmux-item";
  li.innerHTML = `
    <span class="status-dot"></span>
    <span class="session-name">${escapeHtml(t.name)}</span>
    <span class="session-kind kind-tmux">${t.windows}w</span>
  `;
  li.title = `Attacher à la session tmux « ${t.name} »`;
  li.addEventListener("click", () => attachTmuxSession(t.name));
  return li;
}

function updateSidebarInPlace() {
  for (const s of sessions.values()) {
    const li = sectionListEl.querySelector(
      `[data-session-id="${s.id}"]`
    ) as HTMLLIElement | null;
    if (!li) continue;
    li.classList.toggle("active", s.id === activeId);
    li.classList.toggle("kind-agent", s.kind === "agent");
    li.classList.toggle("kind-shell", s.kind !== "agent");
    li.classList.toggle("notif-waiting", s.status === "waiting");
    const dot = li.querySelector(".status-dot") as HTMLSpanElement;
    dot.className = `status-dot ${s.status}`;
    const badgesEl = li.querySelector(".session-badges") as HTMLSpanElement;
    if (badgesEl) {
      badgesEl.innerHTML = badgesHtml(s);
    }
    if (renamingId !== s.id) {
      // displayName (et non s.name) : sinon une session Claude voit son libellé
      // « Claude : <nom> » réécrit avec le nom interne (term-1…) à chaque patch,
      // ce qui le fait osciller avec le renderSidebar de syncClaudeName.
      const name = li.querySelector(".session-name") as HTMLSpanElement;
      const label = displayName(s);
      if (name.textContent !== label) name.textContent = label;
    }
    // Patch the meta line (git branch + ports). Add/remove the div as needed.
    const newMeta = metaLineHtml(s);
    const existingMeta = li.querySelector(".session-meta");
    if (newMeta) {
      if (existingMeta) {
        existingMeta.outerHTML = newMeta;
      } else {
        li.insertAdjacentHTML("beforeend", newMeta);
      }
    } else {
      existingMeta?.remove();
    }
  }
}

// ─── Rename ──────────────────────────────────────────────────────────────────

function beginRenameById(id: string) {
  const s = sessions.get(id);
  if (!s || renamingId) return;
  const li = sectionListEl.querySelector(
    `[data-session-id="${id}"]`
  ) as HTMLLIElement | null;
  if (!li) return;
  beginRename(li, s);
}

function beginRename(li: HTMLLIElement, s: Session) {
  // Sessions Claude : le libellé (« Claude : <nom> ») est piloté par les hooks
  // et resynchronisé en continu depuis Claude — un renommage manuel serait
  // écrasé au prochain event. On l'interdit pour éviter toute confusion ;
  // renommer la session se fait côté Claude (/title).
  if (s.claudeName !== undefined) {
    li.classList.remove("notif-flash");
    void li.offsetWidth;
    li.classList.add("notif-flash");
    return;
  }
  const nameEl = li.querySelector(".session-name") as HTMLSpanElement;
  const oldName = s.name;
  renamingId = s.id;
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.spellcheck = false;
  requestAnimationFrame(() => {
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  const commit = (cancel: boolean) => {
    if (renamingId !== s.id) return;
    nameEl.removeAttribute("contenteditable");
    if (!cancel) {
      const v = nameEl.textContent?.trim();
      if (v && v !== oldName) {
        const unique = uniqueName(v, s.id);
        s.name = unique;
        renameSessionMeta(oldName, unique);
      }
    }
    nameEl.textContent = s.name;
    renamingId = null;
    renderSidebar();
    if (s.id === activeId) updateWindowTitle();
  };
  nameEl.addEventListener("blur", () => commit(false), { once: true });
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameEl.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(true);
    }
  });
}

function beginSectionRename(secEl: HTMLElement, sectionId: string) {
  if (renamingSectionId) return;
  renamingSectionId = sectionId;
  const nameEl = secEl.querySelector(".section-name") as HTMLSpanElement;
  if (!nameEl) {
    renamingSectionId = null;
    return;
  }
  const original = nameEl.textContent ?? "";
  nameEl.setAttribute("contenteditable", "plaintext-only");
  nameEl.spellcheck = false;
  requestAnimationFrame(() => {
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  const commit = (cancel: boolean) => {
    if (renamingSectionId !== sectionId) return;
    nameEl.removeAttribute("contenteditable");
    if (!cancel) {
      const v = nameEl.textContent?.trim();
      if (v && v !== original) renameSection(sectionId, v);
    }
    renamingSectionId = null;
    renderSidebar();
  };
  nameEl.addEventListener("blur", () => commit(false), { once: true });
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameEl.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      nameEl.textContent = original;
      nameEl.blur();
    }
  });
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

// Poignée de redimensionnement entre les 2 panes (créée dans applyLayout).
let splitHandleEl: HTMLDivElement | null = null;
// Listener mousedown de focus clavier (retiré/recréé par applyLayout).
const paneMousedownListeners = new Map<string, () => void>();

/** Seule source de vérité pour le rendu des panes (classes active, flex, order).
 *  Doit être appelée chaque fois que activeId, pinnedId, pinSide ou splitRatio
 *  change. Ne touchons jamais classList.toggle("active") ailleurs. */
function applyLayout() {
  if (pinnedId === null) {
    // Mode simple : plein écran, un seul pane visible à la fois.
    terminalsRoot.classList.remove("split", "split-right", "split-bottom");

    // Retirer la poignée si elle existe.
    if (splitHandleEl) {
      splitHandleEl.remove();
      splitHandleEl = null;
    }

    // Retirer les listeners de focus clavier et la classe pane-focused.
    for (const [sid, listener] of paneMousedownListeners) {
      const s = sessions.get(sid);
      if (s) {
        s.pane.removeEventListener("mousedown", listener);
        s.pane.classList.remove("pane-focused");
      }
    }
    paneMousedownListeners.clear();

    for (const s of sessions.values()) {
      s.pane.classList.toggle("active", s.id === activeId);
      s.pane.style.order = "";
      s.pane.style.flexGrow = "";
    }

    if (activeId) {
      const s = sessions.get(activeId);
      if (s) requestAnimationFrame(() => s.syncSize());
    }
  } else {
    // Mode split : 2 panes côte à côte (right) ou empilés (bottom).
    terminalsRoot.classList.add("split");
    terminalsRoot.classList.toggle("split-right", pinSide === "right");
    terminalsRoot.classList.toggle("split-bottom", pinSide === "bottom");

    // Créer la poignée si elle n'existe pas encore.
    if (!splitHandleEl) {
      splitHandleEl = document.createElement("div");
      splitHandleEl.className = "split-handle";
      terminalsRoot.appendChild(splitHandleEl);

      // Drag pour redimensionner.
      splitHandleEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const onMove = (mv: MouseEvent) => {
          const rect = terminalsRoot.getBoundingClientRect();
          let ratio: number;
          if (pinSide === "right") {
            ratio = (mv.clientX - rect.left) / rect.width;
          } else {
            ratio = (mv.clientY - rect.top) / rect.height;
          }
          splitRatio = Math.max(0.2, Math.min(0.8, ratio));
          // Applique le ratio directement sur les flexGrow sans reconstruire tout le layout.
          if (activeId) {
            const main = sessions.get(activeId);
            if (main) main.pane.style.flexGrow = String(splitRatio);
          }
          const pinned = sessions.get(pinnedId!);
          if (pinned) pinned.pane.style.flexGrow = String(1 - splitRatio);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
    splitHandleEl.style.order = "1";
    splitHandleEl.style.cursor = pinSide === "right" ? "col-resize" : "row-resize";

    // Retirer les anciens listeners de focus clavier avant de les refaire.
    for (const [sid, listener] of paneMousedownListeners) {
      const s = sessions.get(sid);
      if (s) s.pane.removeEventListener("mousedown", listener);
    }
    paneMousedownListeners.clear();

    for (const s of sessions.values()) {
      const isMain = s.id === activeId;
      const isPinned = s.id === pinnedId;
      const visible = isMain || isPinned;
      s.pane.classList.toggle("active", visible);
      if (isMain) {
        s.pane.style.order = "0";
        s.pane.style.flexGrow = String(splitRatio);
      } else if (isPinned) {
        s.pane.style.order = "2";
        s.pane.style.flexGrow = String(1 - splitRatio);
      } else {
        s.pane.style.order = "";
        s.pane.style.flexGrow = "";
      }

      if (visible) {
        // Listener de focus clavier : clic sur un pane → focus + bordure accent.
        const listener = () => {
          // Retirer la classe de focus des autres panes visibles.
          for (const other of sessions.values()) {
            if (other.id === activeId || other.id === pinnedId) {
              other.pane.classList.toggle("pane-focused", other.id === s.id);
            }
          }
          s.term.focus();
        };
        s.pane.addEventListener("mousedown", listener);
        paneMousedownListeners.set(s.id, listener);
        // Focus initial : le pane principal a la priorité.
        s.pane.classList.toggle("pane-focused", isMain);
      } else {
        s.pane.classList.remove("pane-focused");
      }
    }

    requestAnimationFrame(() => {
      if (activeId) sessions.get(activeId)?.syncSize();
      if (pinnedId) sessions.get(pinnedId)?.syncSize();
    });
  }
}

function pinSession(id: string, side: PinSide) {
  if (!sessions.has(id)) return;
  pinnedId = id;
  pinSide = side;
  splitRatio = 0.5;
  // Invariant : activeId ≠ pinnedId.
  if (activeId === id) {
    const other = Array.from(sessions.keys()).find((k) => k !== id);
    if (other) activeId = other;
  }
  applyLayout();
  renderSidebar();
}

function unpin() {
  pinnedId = null;
  applyLayout();
  renderSidebar();
}

function activate(id: string) {
  // L'épinglé est fixe : cliquer son onglet est un no-op.
  if (id === pinnedId) return;
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  applyLayout();
  renderSidebar();
  updateWindowTitle();
  requestAnimationFrame(() => {
    s.syncSize();
    s.term.focus();
  });
}

function updateWindowTitle() {
  const s = activeId ? sessions.get(activeId) : null;
  const title = s ? `${displayName(s)} — noobmux` : "noobmux";
  // Note : sur GNOME/Wayland avec CSD, la barre de titre affiche `productName`
  // (« noobmux ») au lieu de cette chaîne. setTitle change quand même
  // _NET_WM_NAME donc des outils externes (wmctrl, alt-tab certains WM) voient
  // bien le nom de session.
  getCurrentWindow()
    .setTitle(title)
    .catch(() => {});
}

function setStatus(id: string, status: SessionStatus) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  const prev = s.status;
  s.status = status;
  updateSidebarInPlace();
  // Flash quand on passe en waiting depuis un autre état.
  if (status === "waiting" && prev !== "waiting") {
    const li = sectionListEl.querySelector(
      `[data-session-id="${id}"]`
    ) as HTMLLIElement | null;
    if (li) {
      li.classList.remove("notif-flash");
      void li.offsetWidth;
      li.classList.add("notif-flash");
    }
  }
}

function setKind(id: string, kind: SessionKind) {
  const s = sessions.get(id);
  if (!s || s.kind === kind) return;
  s.kind = kind;
  upsertSessionMeta(s.name, { kind });
  updateSidebarInPlace();
}

// Libellé affiché dans la sidebar / le titre de fenêtre. Pour une session
// Claude pilotée par les hooks, le nom interne (s.name, clé de persistance)
// est ignoré au profit de « Claude » ou « Claude : <nom de session Claude> ».
// Les sessions shell/agent non pilotées gardent leur nom tel quel.
function displayName(s: Session): string {
  if (s.claudeName !== undefined) {
    return s.claudeName ? `Claude : ${s.claudeName}` : "Claude";
  }
  return s.name;
}

// Resynchronise le nom de session Claude d'une session noobmux à partir de
// l'UUID Claude reçu dans un hook. Lit ~/.claude/sessions/<pid>.json côté Rust.
// Appelé à chaque agent:event → couvre (a) détection, (b) nom initial, et
// (c) mise à jour quand l'utilisateur renomme la session dans Claude.
async function syncClaudeName(noobmuxId: string, claudeSessionId: string | null) {
  const s = sessions.get(noobmuxId);
  if (!s) return;
  if (claudeSessionId) claudeSessionIds.set(noobmuxId, claudeSessionId);
  let claudeName = "";
  if (claudeSessionId) {
    try {
      claudeName = (await invoke<string | null>("get_claude_session_name", {
        claudeSessionId,
      })) ?? "";
    } catch (e) {
      console.warn("[noobmux] get_claude_session_name failed:", e);
    }
  }
  // La session a pu disparaître pendant l'await.
  const cur = sessions.get(noobmuxId);
  if (!cur || cur.claudeName === claudeName) return;
  cur.claudeName = claudeName;
  // Patch ciblé : seul le libellé change (le badge AI est déjà posé). Éviter
  // renderSidebar() qui reconstruit toute la sidebar à chaque resync de nom.
  updateSidebarInPlace();
  if (cur.id === activeId) updateWindowTitle();
}

function moveSessionToSection(sessionId: string, sectionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  upsertSessionMeta(s.name, { sectionId });
  renderSidebar();
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

async function pickDirectory(): Promise<string | null> {
  const last = localStorage.getItem(LAST_DIR_KEY) ?? undefined;
  const result = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: last,
    title: "Choisir un dossier",
  });
  if (typeof result === "string") {
    localStorage.setItem(LAST_DIR_KEY, result);
    return result;
  }
  return null;
}

function uniqueName(base: string, excludeId?: string): string {
  const existing = new Set(
    Array.from(sessions.values())
      .filter((s) => s.id !== excludeId)
      .map((s) => s.name)
  );
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function spawnSession(opts: {
  kind: SessionKind;
  name?: string;
  command?: string[];
  cwd?: string | null;
  meta?: { tmuxName?: string };
}) {
  terminalsRoot.querySelector(".empty-state")?.remove();
  const id = uuid();
  let defaultName =
    opts.name ??
    (opts.cwd
      ? opts.kind === "agent"
        ? `claude:${basename(opts.cwd)}`
        : basename(opts.cwd)
      : opts.kind === "agent"
        ? `claude-${sessions.size + 1}`
        : `term-${sessions.size + 1}`);
  defaultName = uniqueName(defaultName);

  const s = createSession({
    id,
    name: defaultName,
    kind: opts.kind,
    container: terminalsRoot,
  });
  sessions.set(id, s);

  upsertSessionMeta(s.name, { kind: opts.kind });

  // Rendre le pane visible AVANT le spawn : sans la classe `active` le pane est
  // en display:none → offsetWidth 0 → syncSize ne peut pas mesurer la grille.
  // En activant d'abord, syncSize fite sur la taille réelle et le PTY est créé
  // d'emblée aux bonnes dimensions (sinon spawn à 80×24 → contenu mal placé).
  activate(id);
  s.syncSize();

  try {
    await invoke("spawn_terminal", {
      args: {
        id,
        cwd: opts.cwd ?? null,
        shell: null,
        cols: s.term.cols,
        rows: s.term.rows,
        command: opts.command ?? null,
      },
    });
  } catch (e) {
    s.term.write(`\r\n\x1b[31m[noobmux] failed to spawn: ${e}\x1b[0m\r\n`);
    setStatus(id, "error");
  }

  if (opts.meta?.tmuxName) {
    attachedTmux.add(opts.meta.tmuxName);
    (s as any).tmuxName = opts.meta.tmuxName;
  }

  if (opts.cwd) sessionCwd.set(id, opts.cwd);
  sessionCommand.set(id, opts.command ?? null);

  return s;
}

async function runInSession(id: string, data: string) {
  await invoke("write_to_terminal", { id, data });
}

async function closeSession(id: string, opts?: { killTmux?: boolean }) {
  const s = sessions.get(id);
  if (!s) return;
  // Marquer la fermeture comme pilotée : le pty:exit déclenché par le kill ne
  // doit pas la re-traiter comme une mort spontanée du process.
  closing.add(id);
  const tmuxName = (s as any).tmuxName as string | undefined;

  if (tmuxName && !opts?.killTmux) {
    // Detach propre: envoyer le prefix tmux + 'd'. Par défaut prefix = Ctrl-B (\x02).
    // Si l'utilisateur a un autre prefix, ça peut ne pas marcher — fallback sur kill du client.
    try {
      await invoke("write_to_terminal", { id, data: "\x02d" });
      // Laisser tmux le temps de détacher avant de tuer le PTY au cas où.
      await new Promise((r) => setTimeout(r, 150));
    } catch {}
  } else if (tmuxName && opts?.killTmux) {
    await invoke("tmux_kill_session", { name: tmuxName }).catch(() => {});
  }

  await invoke("kill_terminal", { id }).catch(() => {});
  s.resizeObserver.disconnect();
  s.term.dispose();
  s.pane.remove();
  if (tmuxName) attachedTmux.delete(tmuxName);
  lastScreenCheck.delete(id);
  hookPiloted.delete(id);
  sessionCwd.delete(id);
  sessionCommand.delete(id);
  sessionMetaCache.delete(id);
  // Retirer les listeners de focus clavier pour ce pane.
  const focusListener = paneMousedownListeners.get(id);
  if (focusListener) {
    s.pane.removeEventListener("mousedown", focusListener);
    paneMousedownListeners.delete(id);
  }
  // Retirer le handler clavier d'un éventuel pane mort.
  detachDeadKeyHandler(id);
  removeSessionMeta(s.name);
  sessions.delete(id);
  closing.delete(id);
  exited.delete(id);
  // Désépingler automatiquement si l'épinglé est fermé.
  if (id === pinnedId) pinnedId = null;
  // Choisir un nouveau principal s'il était actif (ne pas choisir l'épinglé).
  if (activeId === id) {
    let next = Array.from(sessions.keys()).find((k) => k !== pinnedId) ?? null;
    if (next === null && pinnedId !== null) {
      // Il ne reste que l'épinglé : sortir du split, il devient le pane principal.
      next = pinnedId;
      pinnedId = null;
    }
    activeId = next;
    updateWindowTitle();
  }
  applyLayout();
  renderSidebar();
  renderEmptyState();
}

// Relance le process d'une session morte DANS le même pane/term existant (même
// id, même position, mêmes meta) : on ré-spawn un PTY backend pour cet id, et le
// term.onData déjà branché recommence à écrire dedans. Le cwd et la command
// d'origine sont rejoués depuis sessionCwd/sessionCommand (encore présents tant
// que closeSession n'a pas tourné).
async function relaunchSession(id: string) {
  const s = sessions.get(id);
  if (!s || !exited.has(id)) return;
  exited.delete(id);
  detachDeadKeyHandler(id);
  s.term.reset();
  s.term.write("\x1b[?25h"); // réafficher le curseur au cas où l'app morte l'a caché.
  setStatus(id, "idle");
  s.syncSize();
  try {
    await invoke("spawn_terminal", {
      args: {
        id,
        cwd: sessionCwd.get(id) ?? null,
        shell: null,
        cols: s.term.cols,
        rows: s.term.rows,
        command: sessionCommand.get(id) ?? null,
      },
    });
    s.term.focus();
  } catch (e) {
    // Échec de relance : remettre la session en état mort avec son hint.
    s.term.write(`\r\n\x1b[31m[noobmux] échec de relance : ${e}\x1b[0m\r\n`);
    markSessionDead(id, null);
  }
}

// Handlers clavier des panes morts, indexés par id pour pouvoir les retirer.
const deadKeyHandlers = new Map<string, (e: KeyboardEvent) => void>();

function detachDeadKeyHandler(id: string) {
  const s = sessions.get(id);
  const h = deadKeyHandlers.get(id);
  if (s && h) s.pane.removeEventListener("keydown", h, true);
  deadKeyHandlers.delete(id);
}

// Affiche un pane comme « mort » : libellé [exited], hint d'action, et capture
// clavier au niveau du pane (le PTY n'existe plus, term.onData ne mène nulle
// part). Entrée/r → relancer ; q/Échap/Ctrl+D → fermer.
function markSessionDead(id: string, code: number | null) {
  const s = sessions.get(id);
  if (!s) return;
  const label = code == null ? "[exited]" : `[exited ${code}]`;
  const color = code ? "31" : "90"; // rouge si code non-nul, gris sinon
  s.term.write(`\r\n\x1b[${color}m${label}\x1b[0m\r\n`);
  s.term.write(
    "\x1b[90m[noobmux] Entrée/r pour relancer · q ou Ctrl+D pour fermer\x1b[0m\r\n"
  );
  exited.add(s.id);
  setStatus(s.id, code ? "error" : "done");
  lastScreenCheck.delete(s.id);
  hookPiloted.delete(s.id);

  detachDeadKeyHandler(id); // idempotent : pas de doublon si déjà mort.
  const handler = (ev: KeyboardEvent) => {
    if (!exited.has(id)) return;
    const isRelaunch = ev.key === "Enter" || ev.key === "r";
    const isClose =
      ev.key === "q" ||
      ev.key === "Escape" ||
      (ev.key === "d" && ev.ctrlKey);
    if (!isRelaunch && !isClose) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (isRelaunch) void relaunchSession(id);
    else void closeSession(id);
  };
  // Capture sur le pane : le keydown vise le <textarea> de xterm (enfant du
  // pane) ; en phase capture on l'intercepte avant que xterm ne le consomme.
  s.pane.addEventListener("keydown", handler, true);
  deadKeyHandlers.set(id, handler);
  // Focaliser le textarea de xterm pour que les touches arrivent sans clic.
  s.term.focus();
}

async function attachTmuxSession(name: string) {
  if (attachedTmux.has(name)) return;
  await spawnSession({
    kind: "shell",
    name: `tmux:${name}`,
    command: ["tmux", "attach", "-t", name],
    meta: { tmuxName: name },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

/** Construit la commande ssh pour un profil. Retourne un string[] (jamais une
 *  string shell concaténée) pour éviter toute injection. */
function buildSshCommand(p: SshProfile): string[] {
  const cmd = ["ssh"];
  if (p.port) cmd.push("-p", String(p.port));
  cmd.push(p.user ? `${p.user}@${p.host}` : p.host);
  return cmd;
}

// ─── Tmux polling ────────────────────────────────────────────────────────────

// Stockage du cwd de chaque session noobmux (utile pour features futures).
const sessionCwd = new Map<string, string>();
// Commande de spawn de chaque session (null = shell par défaut). Utile pour
// reconstruire la session à la restauration au reload.
const sessionCommand = new Map<string, string[] | null>();

interface SessionRuntimeMeta {
  gitBranch?: string;
  ports?: number[];
  foregroundComm?: string;
}
const sessionMetaCache = new Map<string, SessionRuntimeMeta>();

/** Process names considered as "shell" — no Shift+Enter trickery. */
const SHELL_COMMS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "elvish", "nu", "xonsh",
]);

/** Clients d'accès distant : le shell réel tourne sur la machine cible, donc on
 *  ne peut pas inspecter son arbre de process via /proc local. Le foreground
 *  local reste figé sur ce client tant que la connexion est ouverte → on
 *  affiche un statut « ssh » dédié plutôt qu'un faux « running » permanent. */
const SSH_COMMS = new Set([
  "ssh", "mosh", "mosh-client", "et", "sshpass", "autossh",
]);

export function isSshComm(comm: string | undefined): boolean {
  if (!comm) return false;
  return SSH_COMMS.has(comm.toLowerCase());
}

export function shouldUseExtendedShiftEnter(comm: string | undefined): boolean {
  if (!comm) return false;
  return !SHELL_COMMS.has(comm.toLowerCase());
}

/** Statut d'un shell = process foreground réel, pas l'output. Si le foreground
 *  est le shell lui-même (ou inconnu : prompt vide juste après spawn) → au
 *  prompt, idle. Si c'est un client SSH/mosh, on ne peut pas voir l'arbre
 *  distant → statut « ssh » neutre. Sinon une commande tourne → running. No-op
 *  sur les sessions agent (statut piloté par hooks/screen). */
function applyShellStatus(s: Session, foregroundComm: string | undefined) {
  if (s.kind !== "shell") return;
  const fg = foregroundComm?.toLowerCase();
  if (fg !== undefined && SSH_COMMS.has(fg)) {
    setStatus(s.id, "ssh");
    return;
  }
  const atPrompt = fg === undefined || SHELL_COMMS.has(fg);
  setStatus(s.id, atPrompt ? "idle" : "running");
}

// Poll léger dédié au statut des shells : ne lit que le process foreground via
// /proc (pas de git/ports), donc tournable à haute fréquence sans coût notable.
// Le poll meta complet (git branch via sous-process, scan des ports) reste à
// 4 s. Sépare une info qui doit être réactive d'infos coûteuses qui peuvent
// rester lentes.
async function pollShellStatus() {
  for (const s of sessions.values()) {
    if (s.kind !== "shell") continue;
    if (exited.has(s.id)) continue; // process mort, statut figé en done/error
    try {
      const pid = await invoke<number | null>("get_pty_pid", { id: s.id }).catch(() => null);
      if (pid == null) continue;
      const comm = await invoke<string | null>("get_foreground_process", { pid });
      // La session a pu être fermée/mourir pendant les awaits ci-dessus.
      if (!sessions.has(s.id) || exited.has(s.id)) continue;
      applyShellStatus(s, comm ?? undefined);
      // Faire apparaître/disparaître le badge « ssh » sans attendre le poll meta
      // (4 s) : ce poll-ci tourne plus vite. On ne re-render qu'au franchissement
      // de la frontière SSH↔non-SSH, le seul changement visible ici.
      const cached = sessionMetaCache.get(s.id);
      const nextComm = comm ?? undefined;
      if (isSshComm(cached?.foregroundComm) !== isSshComm(nextComm)) {
        sessionMetaCache.set(s.id, { ...cached, foregroundComm: nextComm });
        updateSidebarInPlace();
      }
    } catch {
      // ignore
    }
  }
}

async function refreshSessionMetadata() {
  for (const s of sessions.values()) {
    if (exited.has(s.id)) continue; // plus de process à interroger
    try {
      const pid = await invoke<number | null>("get_pty_pid", { id: s.id }).catch(() => null);
      const cwd = sessionCwd.get(s.id) ?? null;
      const meta = await invoke<{
        git_branch: string | null;
        ports: number[];
        foreground_comm: string | null;
      }>("get_session_metadata", { cwd, pid });
      // La session a pu être fermée/mourir pendant les awaits ci-dessus.
      if (!sessions.has(s.id) || exited.has(s.id)) continue;
      const prev = sessionMetaCache.get(s.id);
      const next: SessionRuntimeMeta = {
        gitBranch: meta.git_branch ?? undefined,
        ports: meta.ports,
        foregroundComm: meta.foreground_comm ?? undefined,
      };
      // Propage le mode foreground vers session.ts pour décider de Shift+Enter.
      const setFg = (s.term as any).__noobmux_setForegroundComm as
        | ((c: string | undefined) => void)
        | undefined;
      setFg?.(next.foregroundComm);

      // Re-render si une info AFFICHÉE change : branche git, ports, ou bascule
      // SSH↔non-SSH (le badge « ssh » en dépend). Un simple changement de
      // foregroundComm sans franchir la frontière SSH n'affecte rien de visible.
      if (
        prev?.gitBranch !== next.gitBranch ||
        prev?.ports?.join(",") !== next.ports?.join(",") ||
        isSshComm(prev?.foregroundComm) !== isSshComm(next.foregroundComm)
      ) {
        sessionMetaCache.set(s.id, next);
        updateSidebarInPlace();
      }
    } catch {
      // ignore
    }
  }
}

async function pollTmux() {
  try {
    const list = await invoke<{ name: string; attached: boolean; windows: number }[]>(
      "list_tmux_sessions"
    );
    // Garder ce qui n'est pas attaché ailleurs ou ici.
    tmuxAvailable = list.map((t) => ({ name: t.name, windows: t.windows }));
    renderSidebar();
  } catch (e) {
    // tmux pas installé, on ignore
  }
}

// ─── Wiring events ───────────────────────────────────────────────────────────

/** Lit l'écran live (les `rows` dernières lignes du buffer) en ignorant le
 *  scroll de l'utilisateur. Sans ça, scroller vers le haut sortirait le
 *  footer Claude du viewport et figerait la détection de statut. */
function readScreen(term: import("@xterm/xterm").Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  // baseY = première ligne de l'écran live (peu importe où l'user a scrollé).
  const start = buf.baseY;
  const end = start + term.rows;
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

const lastScreenCheck = new Map<string, number>();

// Sessions qui ont déjà reçu au moins un hook : on considère les hooks comme
// source de vérité unique et on désactive le parsing visuel pour éviter les
// yoyo (le footer Claude post-turn matche encore des patterns running et
// déclenche des transitions fantômes après Stop).
const hookPiloted = new Set<string>();

// noobmuxId → UUID de la session Claude, mémorisé depuis les hooks. Sert au
// poll périodique de resync du nom (cas où l'utilisateur fait /title dans
// Claude sans déclencher de nouvel event de hook ensuite).
const claudeSessionIds = new Map<string, string>();

listen<{ id: string; data: string }>("pty:output", (e) => {
  const s = sessions.get(e.payload.id);
  if (!s) return;
  s.term.write(e.payload.data);
  s.lastOutputAt = Date.now();


  if (s.kind === "shell" && looksLikeClaude(e.payload.data)) {
    setKind(s.id, "agent");
    // Renommage auto en « Claude » dès la détection visuelle (hooks absents ou
    // pas encore reçus). Si les hooks sont actifs, syncClaudeName affinera
    // ensuite avec le nom de session réel (« Claude : <nom> »).
    if (s.claudeName === undefined) {
      s.claudeName = "";
      // Patch ciblé : setKind ci-dessus a déjà mis à jour le badge ; ici seul le
      // libellé bascule sur « Claude ». Pas besoin de reconstruire la sidebar.
      updateSidebarInPlace();
      if (s.id === activeId) updateWindowTitle();
    }
  }

  if (s.kind === "agent") {
    // Throttle ~12 Hz pour réduire la latence sans saturer la mainloop.
    const now = Date.now();
    const last = lastScreenCheck.get(s.id) ?? 0;
    if (now - last > 80) {
      lastScreenCheck.set(s.id, now);
      requestAnimationFrame(() => {
        // Hooks pilotent : le parsing visuel ne fait rien.
        if (hookPiloted.has(s.id)) return;
        const screen = readScreen(s.term);
        const claudeStatus = detectClaudeStatusFromScreen(screen);
        if (!claudeStatus) return;
        setStatus(s.id, claudeStatus);
      });
    }
  }
  // Le statut d'un shell n'est PLUS dérivé de l'output (regex de prompt
  // fragile : prompt riche/Starship jamais matché → vert collé en permanence).
  // Il est piloté par le process foreground réel dans refreshSessionMetadata.

  const tmuxName = detectTmuxSession(e.payload.data);
  if (tmuxName && (s as any).tmuxName !== tmuxName) {
    (s as any).tmuxName = tmuxName;
    attachedTmux.add(tmuxName);
    renderSidebar();
  }

  // OSC notifications: tout terminal/agent émettant ces séquences (cmux,
  // iTerm2-style, kitty…) déclenche le statut waiting. Si la session n'est
  // pas active, on flash pour attirer l'œil.
  const oscs = detectOscNotifications(e.payload.data);
  if (oscs.length > 0) {
    setStatus(s.id, "waiting");
  }
});

// Re-scan périodique : l'écran d'une session agent peut évoluer (l'utilisateur
// dismiss un prompt, Claude finit silencieusement…) sans qu'aucun pty:output
// ne soit reçu. Sans ce poll, le statut peut rester figé en "waiting".
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.kind !== "agent") continue;
    if (hookPiloted.has(s.id)) continue;
    const screen = readScreen(s.term);
    const claudeStatus = detectClaudeStatusFromScreen(screen);
    if (!claudeStatus || claudeStatus === s.status) continue;
    setStatus(s.id, claudeStatus);
  }
}, 1000);

// Re-scan périodique des noms de session Claude : si l'utilisateur fait /title
// dans Claude sans déclencher d'autre event de hook, le nom changerait dans
// ~/.claude/sessions/<pid>.json sans qu'on en soit notifié. Ce poll lent
// rattrape ces renommages « silencieux ». syncClaudeName est un no-op si le
// nom n'a pas bougé (pas de re-render inutile).
setInterval(() => {
  for (const [noobmuxId, claudeSessionId] of claudeSessionIds) {
    if (!sessions.has(noobmuxId)) {
      claudeSessionIds.delete(noobmuxId);
      continue;
    }
    void syncClaudeName(noobmuxId, claudeSessionId);
  }
}, 2000);

listen<{ id: string; code: number | null }>("pty:exit", (e) => {
  const s = sessions.get(e.payload.id);
  if (!s) return;
  // Fermeture pilotée par l'utilisateur : closeSession fait/a fait le teardown.
  if (closing.has(e.payload.id)) return;

  // Process mort tout seul (exit, crash, fin de commande, ssh broken pipe…). Le
  // PTY backend est déjà retiré côté Rust. On fige la session en « done »/« error »
  // (plutôt qu'« idle » trompeur), on coupe les polls, et on affiche un pane mort
  // interactif : le PTY ne reçoit plus rien, donc on capte les touches au niveau
  // du pane pour proposer relance (Entrée/r) ou fermeture (q/Ctrl+D).
  markSessionDead(s.id, e.payload.code);
});

listen<{
  session_id: string | null;
  claude_session_id?: string | null;
  cwd?: string | null;
  event: string;
  payload: any;
}>(
  "agent:event",
  (e) => {
    const sid = e.payload.session_id;
    const ev = e.payload.event;
    if (!sid) return;
    // Premier hook reçu pour cette session → on bascule en mode "hooks pilotent",
    // le parsing visuel devient inactif (évite les yoyo post-Stop).
    hookPiloted.add(sid);
    // Un hook Claude a parlé → c'est une session agent à coup sûr (badge AI).
    setKind(sid, "agent");
    // Resynchronise le libellé « Claude » / « Claude : <nom> » à chaque event :
    // gère le nom initial et les renommages faits dans Claude (/title) au fil
    // de la session. No-op si rien n'a changé.
    syncClaudeName(sid, e.payload.claude_session_id ?? null);
    // Mapping hook → statut. Source de vérité prioritaire sur le parsing visuel.
    //  UserPromptSubmit  : l'user vient de soumettre → Claude commence à bosser
    //  PreToolUse        : Claude utilise un outil → toujours running
    //  PostToolUse       : fin d'un outil mais Claude continue le turn → running
    //  Stop              : fin du turn → idle
    //  Notification      : prompt de permission ou attention requise → waiting
    if (ev === "UserPromptSubmit" || ev === "PreToolUse" || ev === "PostToolUse") {
      setStatus(sid, "running");
    } else if (ev === "Stop") {
      // Fin de turn : "done" (Claude n'a rien à faire, à toi de jouer si tu
      // veux). On garde idle pour le cas où Claude n'a jamais été utilisé.
      setStatus(sid, "done");
    } else if (ev === "Notification") {
      // Les forks "auto mode" envoient une Notification cosmétique à la fin
      // du turn ("Claude is waiting for your input"). On la traite comme un
      // Stop pour ne pas alarmer faussement l'utilisateur. Les vraies demandes
      // (permission, question de Claude) ont d'autres wordings et passent en
      // waiting (orange clignotant).
      const msg = String(e.payload.payload?.message ?? "").toLowerCase();
      const isCosmetic = msg.includes("waiting for your input");
      setStatus(sid, isCosmetic ? "done" : "waiting");
    }
  }
);

document.getElementById("new-terminal")?.addEventListener("click", async (e) => {
  const cwd = (e as MouseEvent).shiftKey ? await pickDirectory() : null;
  if ((e as MouseEvent).shiftKey && !cwd) return;
  spawnSession({ kind: "shell", cwd });
});

document.getElementById("new-terminal-menu")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu({
    x: rect.left,
    y: rect.top - 8,
    customItems: [
      {
        label: "Nouveau terminal dans un dossier…",
        onClick: async () => {
          const cwd = await pickDirectory();
          if (!cwd) return;
          spawnSession({ kind: "shell", cwd });
        },
      },
      {
        label: "Nouvelle session Claude dans un dossier…",
        onClick: async () => {
          const cwd = await pickDirectory();
          if (!cwd) return;
          spawnSession({ kind: "agent", command: ["claude"], cwd });
        },
      },
      {
        label: "Nouvelle session tmux…",
        onClick: async () => {
          const name = await promptText({
            title: "Nouvelle session tmux",
            placeholder: "Nom de la session (laisser vide pour auto)",
          });
          if (name === null) return;
          const cwd = await pickDirectory();
          if (!cwd) return;
          const args = name
            ? ["tmux", "new-session", "-A", "-s", name]
            : ["tmux", "new-session"];
          spawnSession({
            kind: "shell",
            cwd,
            command: args,
            name: name ? `tmux:${name}` : undefined,
            meta: name ? { tmuxName: name } : undefined,
          });
        },
      },
      {
        label: "Attacher une session tmux existante…",
        onClick: async () => {
          const list = await invoke<{ name: string; attached: boolean }[]>(
            "list_tmux_sessions"
          );
          const available = list.filter((t) => !t.attached && !attachedTmux.has(t.name));
          if (available.length === 0) {
            alert("Aucune session tmux disponible à attacher.");
            return;
          }
          // Délégué à un sous-menu rapide.
          showContextMenu({
            x: rect.left,
            y: rect.top - 8,
            customItems: available.map((t) => ({
              label: t.name,
              onClick: () => attachTmuxSession(t.name),
            })),
          });
        },
      },
      {
        label: "Nouvelle session SSH…",
        onClick: () => {
          const profiles = getConfig().sshProfiles ?? [];
          if (profiles.length === 0) {
            // Aucun profil : ouvrir les réglages pour en créer un.
            openSettingsModal({ onChange: applySettingsToSessions });
            return;
          }
          showContextMenu({
            x: rect.left,
            y: rect.top - 8,
            customItems: profiles.map((p) => ({
              label: p.label || (p.user ? `${p.user}@${p.host}` : p.host),
              onClick: () =>
                spawnSession({
                  kind: "shell",
                  name: `ssh:${p.label || p.host}`,
                  command: buildSshCommand(p),
                  cwd: p.cwd ?? null,
                }),
            })),
          });
        },
      },
    ],
  });
});

document.getElementById("open-settings")?.addEventListener("click", () => {
  openSettingsModal({ onChange: applySettingsToSessions });
});

function applySettingsToSessions() {
  const cfg = getConfig();
  for (const s of sessions.values()) {
    s.term.options.fontFamily = cfg.ui.fontFamily;
    s.term.options.fontSize = cfg.ui.fontSize;
    s.term.options.theme = getTheme(cfg.ui.themeId).term;
    // Force xterm à recalculer après changement de police/taille.
    requestAnimationFrame(() => s.syncSize());
  }
}

document.getElementById("new-section")?.addEventListener("click", () => {
  const sec = addSection("Nouvelle section");
  // Lock immédiatement pour bloquer tout re-render externe (pollTmux, etc.)
  // entre la création et l'arrivée du focus dans le contenteditable.
  renamingSectionId = sec.id;
  renderSidebar();
  requestAnimationFrame(() => {
    const secEl = sectionListEl.querySelector(
      `[data-section-id="${sec.id}"]`
    ) as HTMLElement | null;
    if (secEl) {
      // beginSectionRename refuse de tourner si renamingSectionId est déjà set,
      // donc on le reset juste avant.
      renamingSectionId = null;
      beginSectionRename(secEl, sec.id);
    } else {
      renamingSectionId = null;
    }
  });
});

window.addEventListener("resize", () => {
  for (const s of sessions.values()) {
    if (s.pane.classList.contains("active")) s.syncSize();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F2" && activeId) beginRenameById(activeId);
});

// Maintenir l'ordre persistant chaque fois qu'on render.
function persistOrder() {
  const order = Array.from(sessions.values()).map((s) => s.name);
  setSessionOrder(order);
}

/** Capture un snapshot de toutes les sessions vivantes pour les recréer au reload. */
async function captureSessionsToRestore() {
  const order = getConfig().sessionOrder;
  const live = Array.from(sessions.values());
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  live.sort((a, b) => rank(a.name) - rank(b.name));

  const out: SessionRestore[] = [];
  for (const s of live) {
    if (exited.has(s.id)) continue;
    let cwd = sessionCwd.get(s.id) ?? null;
    try {
      const pid = await invoke<number | null>("get_pty_pid", { id: s.id }).catch(() => null);
      if (pid != null) {
        const meta = await invoke<{ resolved_cwd: string | null }>(
          "get_session_metadata", { cwd, pid }
        );
        if (meta.resolved_cwd) cwd = meta.resolved_cwd;
      }
    } catch { /* garder le cwd de spawn */ }
    // Une session « agent » lancée en tapant `claude` à la main dans un shell a
    // été détectée visuellement (kind=agent, badge AI) mais sa commande de spawn
    // est restée nulle. Pour la restaurer fidèlement, on relance `claude` — et si
    // on connaît son UUID Claude (capté via les hooks, cf. claudeSessionIds), on
    // reprend la conversation existante avec `--resume <uuid>` plutôt que d'ouvrir
    // une session vierge. Sans UUID (hooks absents), on retombe sur `claude` nu.
    let command = sessionCommand.get(s.id) ?? null;
    if (s.kind === "agent" && command === null) {
      const claudeId = claudeSessionIds.get(s.id);
      command = claudeId ? ["claude", "--resume", claudeId] : ["claude"];
    }
    out.push({
      name: s.name,
      kind: s.kind,
      cwd,
      command,
      tmuxName: (s as any).tmuxName as string | undefined,
    });
  }
  setSessionsToRestore(out);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

declare const __APP_VERSION__: string;

function setupSidebarResizer() {
  const sidebar = document.getElementById("sidebar") as HTMLElement;
  const resizer = document.getElementById("sidebar-resizer") as HTMLElement;
  if (!sidebar || !resizer) return;
  const cfg = getConfig();
  sidebar.style.width = `${cfg.ui.sidebarWidth}px`;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(560, startWidth + (e.clientX - startX)));
    sidebar.style.width = `${w}px`;
    // Le ResizeObserver du pane actif détecte le changement de largeur et
    // refite (xterm reflow en direct, PTY notifié en trailing-edge debouncé).
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const w = sidebar.getBoundingClientRect().width;
    updateUI({ sidebarWidth: Math.round(w) });
  });
}

(async () => {
  await loadConfig();
  applyThemeToRoot(getTheme(getConfig().ui.themeId));
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;
  setupSidebarResizer();
  renderSidebar();
  renderEmptyState();

  // Restauration des sessions enregistrées au dernier reload.
  {
    const toRestore = getConfig().sessionsToRestore ?? [];
    for (const r of toRestore) {
      if (r.tmuxName) {
        try {
          const list = await invoke<{ name: string }[]>("list_tmux_sessions");
          if (list.some((t) => t.name === r.tmuxName)) {
            await attachTmuxSession(r.tmuxName);
          }
        } catch { /* tmux indispo → skip */ }
        continue;
      }
      await spawnSession({
        kind: r.kind,
        name: r.name,
        command: r.command ?? undefined,
        cwd: r.cwd,
      });
    }
  }

  pollTmux();
  setInterval(pollTmux, 3000);
  refreshSessionMetadata();
  setInterval(refreshSessionMetadata, 4000);
  pollShellStatus();
  setInterval(pollShellStatus, 1000);
  // Auto-check updates au boot (silencieux). 3s de délai pour ne pas bloquer.
  setTimeout(async () => {
    const update = await checkForUpdate({ silent: true });
    if (update) showUpdateBanner(update);
  }, 3000);
  // Persistance d'ordre périodique légère + capture d'état pour restauration
  // (~4 s : chaque 2e tick à 2 s). Démarré APRÈS la boucle de restauration pour
  // ne pas écraser sessionsToRestore pendant la phase d'init.
  let restoreTick = 0;
  setInterval(() => {
    persistOrder();
    if (restoreTick++ % 2 === 0) void captureSessionsToRestore();
  }, 2000);
  // Sauver à la fermeture (best-effort, sans await).
  window.addEventListener("beforeunload", () => {
    void captureSessionsToRestore();
    persistOrder();
    scheduleSave();
  });
})();
