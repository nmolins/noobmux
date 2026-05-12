import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { v4 as uuid } from "uuid";

import {
  Session,
  SessionKind,
  SessionStatus,
  createSession,
  inferStatusFromOutput,
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
  toggleSection,
  updateUI,
  upsertSessionMeta,
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
let activeId: string | null = null;
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

function buildSessionItem(s: Session): HTMLLIElement {
  const cfg = getConfig();
  const meta = cfg.sessionMeta[s.name];
  const color = meta?.color || null;

  const li = document.createElement("li");
  li.className =
    "session-item" +
    (s.id === activeId ? " active" : "") +
    (s.status === "waiting" ? " notif-waiting" : "");
  li.dataset.sessionId = s.id;
  li.draggable = true;
  if (color) li.style.setProperty("--session-color", color);

  const tmuxName = (s as any).tmuxName as string | undefined;
  const badges = [
    s.kind === "agent"
      ? `<span class="session-kind kind-ai">AI</span>`
      : `<span class="session-kind kind-sh">sh</span>`,
    tmuxName
      ? `<span class="session-kind kind-tmux" title="tmux:${escapeHtml(tmuxName)}">tmux</span>`
      : "",
  ].join("");

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
  const metaLine = metaParts.length > 0 ? `<div class="session-meta">${metaParts.join("")}</div>` : "";

  li.innerHTML = `
    <div class="session-row">
      <span class="status-dot ${s.status}"></span>
      <span class="session-name">${escapeHtml(s.name)}</span>
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
    activate(s.id);
    const cfg = getConfig();
    const currentSection = cfg.sessionMeta[s.name]?.sectionId ?? "default";
    const tmuxName = (s as any).tmuxName as string | undefined;
    showContextMenu({
      x: e.clientX,
      y: e.clientY,
      closeLabel: tmuxName ? "Détacher tmux" : "Fermer",
      onRun: (cmd) => runInSession(s.id, cmd + "\n"),
      onRename: () => beginRenameById(s.id),
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
    li.classList.toggle("notif-waiting", s.status === "waiting");
    const dot = li.querySelector(".status-dot") as HTMLSpanElement;
    dot.className = `status-dot ${s.status}`;
    const badges = li.querySelector(".session-badges") as HTMLSpanElement;
    if (badges) {
      const tmuxName = (s as any).tmuxName as string | undefined;
      badges.innerHTML =
        (s.kind === "agent"
          ? `<span class="session-kind kind-ai">AI</span>`
          : `<span class="session-kind kind-sh">sh</span>`) +
        (tmuxName
          ? `<span class="session-kind kind-tmux" title="tmux:${escapeHtml(tmuxName)}">tmux</span>`
          : "");
    }
    if (renamingId !== s.id) {
      const name = li.querySelector(".session-name") as HTMLSpanElement;
      if (name.textContent !== s.name) name.textContent = s.name;
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
        s.name = v;
        renameSessionMeta(oldName, v);
      }
    }
    nameEl.textContent = s.name;
    renamingId = null;
    renderSidebar();
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

function activate(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  for (const other of sessions.values()) {
    other.pane.classList.toggle("active", other.id === id);
  }
  renderSidebar();
  requestAnimationFrame(() => {
    s.fit.fit();
    s.term.focus();
  });
}

function setStatus(id: string, status: SessionStatus) {
  const s = sessions.get(id);
  if (!s || s.status === status) return;
  const prev = s.status;
  s.status = status;
  renderSidebar();
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
  renderSidebar();
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

function uniqueName(base: string): string {
  const existing = new Set(Array.from(sessions.values()).map((s) => s.name));
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

  activate(id);
  return s;
}

async function runInSession(id: string, data: string) {
  await invoke("write_to_terminal", { id, data });
}

async function closeSession(id: string, opts?: { killTmux?: boolean }) {
  const s = sessions.get(id);
  if (!s) return;
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
  s.term.dispose();
  s.pane.remove();
  if (tmuxName) attachedTmux.delete(tmuxName);
  lastScreenCheck.delete(id);
  sessionCwd.delete(id);
  sessionMetaCache.delete(id);
  removeSessionMeta(s.name);
  sessions.delete(id);
  if (activeId === id) {
    activeId = sessions.keys().next().value ?? null;
    if (activeId) activate(activeId);
  }
  renderSidebar();
  renderEmptyState();
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

// ─── Tmux polling ────────────────────────────────────────────────────────────

// Stockage du cwd de chaque session noobmux (utile pour features futures).
const sessionCwd = new Map<string, string>();

interface SessionRuntimeMeta {
  gitBranch?: string;
  ports?: number[];
}
const sessionMetaCache = new Map<string, SessionRuntimeMeta>();

async function refreshSessionMetadata() {
  for (const s of sessions.values()) {
    try {
      const pid = await invoke<number | null>("get_pty_pid", { id: s.id }).catch(() => null);
      const cwd = sessionCwd.get(s.id) ?? null;
      const meta = await invoke<{ git_branch: string | null; ports: number[] }>(
        "get_session_metadata",
        { cwd, pid }
      );
      const prev = sessionMetaCache.get(s.id);
      const next: SessionRuntimeMeta = {
        gitBranch: meta.git_branch ?? undefined,
        ports: meta.ports,
      };
      if (
        prev?.gitBranch !== next.gitBranch ||
        prev?.ports?.join(",") !== next.ports?.join(",")
      ) {
        sessionMetaCache.set(s.id, next);
        renderSidebar();
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

/** Lit le contenu actuel de l'écran xterm sous forme de string. */
function readScreen(term: import("@xterm/xterm").Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  const start = buf.viewportY;
  const end = start + term.rows;
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

const lastScreenCheck = new Map<string, number>();

listen<{ id: string; data: string }>("pty:output", (e) => {
  const s = sessions.get(e.payload.id);
  if (!s) return;
  s.term.write(e.payload.data);
  s.lastOutputAt = Date.now();

  if (s.kind === "shell" && looksLikeClaude(e.payload.data)) {
    setKind(s.id, "agent");
  }

  if (s.kind === "agent") {
    // Throttle ~12 Hz pour réduire la latence sans saturer la mainloop.
    const now = Date.now();
    const last = lastScreenCheck.get(s.id) ?? 0;
    if (now - last > 80) {
      lastScreenCheck.set(s.id, now);
      requestAnimationFrame(() => {
        const screen = readScreen(s.term);
        const claudeStatus = detectClaudeStatusFromScreen(screen);
        if (claudeStatus) {
          setStatus(s.id, claudeStatus);
        }
      });
    }
  } else {
    setStatus(s.id, inferStatusFromOutput(s.status, e.payload.data));
  }

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

listen<{ id: string; code: number | null }>("pty:exit", (e) => {
  const s = sessions.get(e.payload.id);
  if (!s) return;
  s.term.write(`\r\n\x1b[90m[exited]\x1b[0m\r\n`);
  setStatus(s.id, "idle");
});

listen<{ session_id: string | null; event: string; payload: any }>(
  "agent:event",
  (e) => {
    const sid = e.payload.session_id;
    if (!sid) return;
    if (e.payload.event === "Notification" || e.payload.event === "UserPromptSubmit") {
      setStatus(sid, "waiting");
    } else if (e.payload.event === "Stop") {
      setStatus(sid, "idle");
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
    requestAnimationFrame(() => s.fit.fit());
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
    if (s.pane.classList.contains("active")) s.fit.fit();
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
    for (const s of sessions.values()) {
      if (s.pane.classList.contains("active")) s.fit.fit();
    }
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
  pollTmux();
  setInterval(pollTmux, 3000);
  refreshSessionMetadata();
  setInterval(refreshSessionMetadata, 4000);
  // Auto-check updates au boot (silencieux). 3s de délai pour ne pas bloquer.
  setTimeout(async () => {
    const update = await checkForUpdate({ silent: true });
    if (update) showUpdateBanner(update);
  }, 3000);
  // Persistance d'ordre périodique légère.
  setInterval(persistOrder, 2000);
  // Sauver à la fermeture.
  window.addEventListener("beforeunload", () => {
    persistOrder();
    scheduleSave();
  });
})();
