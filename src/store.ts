import { invoke } from "@tauri-apps/api/core";
import type { SessionKind } from "./session";
import { DEFAULT_COMMANDS, type QuickCommand } from "./commands";

export interface SectionConfig {
  id: string;
  name: string;
  collapsed: boolean;
  /** Special built-in section that lists detached tmux sessions live. */
  builtin?: "tmux";
}

export interface SessionMeta {
  name: string;
  kind: SessionKind;
  color: string | null;
  sectionId: string | null;
}

export interface UISettings {
  themeId: string;
  fontSize: number;
  fontFamily: string;
  sidebarWidth: number;
}

/** Snapshot d'une session suffisant pour la recréer au reload. */
export interface SessionRestore {
  name: string;
  kind: SessionKind;
  cwd: string | null;
  /** Commande de spawn explicite (ex. ["claude"], ["tmux","attach","-t","foo"]).
   *  null = shell par défaut du système. */
  command: string[] | null;
  /** Nom de la session tmux sous-jacente (uniquement pour les sessions tmux). */
  tmuxName?: string;
}

export interface SshProfile {
  label: string;
  host: string;
  user?: string;
  port?: number;
  cwd?: string;
}

export interface NoobmuxConfig {
  sections: SectionConfig[];
  /** Ordered list of session ids inside the sidebar (excluding tmux builtin). */
  sessionOrder: string[];
  /** Per-session persistent metadata, keyed by stable name (since session ids are ephemeral). */
  sessionMeta: Record<string, SessionMeta>;
  ui: UISettings;
  quickCommands: QuickCommand[];
  sshProfiles: SshProfile[];
  /** Sessions à restaurer au prochain reload. Mis à jour en arrière-plan toutes les ~4 s. */
  sessionsToRestore: SessionRestore[];
}

const DEFAULT_UI: UISettings = {
  themeId: "tokyo-night",
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
  sidebarWidth: 240,
};

const DEFAULT_CONFIG: NoobmuxConfig = {
  sections: [
    { id: "default", name: "Sessions", collapsed: false },
    { id: "tmux", name: "tmux", collapsed: false, builtin: "tmux" },
  ],
  sessionOrder: [],
  sessionMeta: {},
  ui: structuredClone(DEFAULT_UI),
  quickCommands: structuredClone(DEFAULT_COMMANDS),
  sshProfiles: [],
  sessionsToRestore: [],
};

let cache: NoobmuxConfig = structuredClone(DEFAULT_CONFIG);
let saveTimer: number | null = null;

export async function loadConfig(): Promise<NoobmuxConfig> {
  try {
    const raw = (await invoke<Record<string, unknown>>("load_config")) ?? {};
    cache = mergeWithDefaults(raw);
  } catch (e) {
    console.warn("[noobmux] load_config failed:", e);
    cache = structuredClone(DEFAULT_CONFIG);
  }
  return cache;
}

export function getConfig(): NoobmuxConfig {
  return cache;
}

export function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    invoke("save_config", { config: cache }).catch((e) =>
      console.warn("[noobmux] save_config failed:", e)
    );
  }, 300);
}

function mergeWithDefaults(raw: Record<string, unknown>): NoobmuxConfig {
  const out: NoobmuxConfig = structuredClone(DEFAULT_CONFIG);
  const rawSections = Array.isArray(raw.sections) ? (raw.sections as SectionConfig[]) : [];
  if (rawSections.length > 0) {
    out.sections = rawSections.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      collapsed: !!s.collapsed,
      builtin: s.builtin === "tmux" ? "tmux" : undefined,
    }));
    // Ensure mandatory sections exist.
    if (!out.sections.find((s) => s.id === "default")) {
      out.sections.unshift({ id: "default", name: "Sessions", collapsed: false });
    }
    if (!out.sections.find((s) => s.builtin === "tmux")) {
      out.sections.push({ id: "tmux", name: "tmux", collapsed: false, builtin: "tmux" });
    }
  }
  if (Array.isArray(raw.sessionOrder)) {
    out.sessionOrder = (raw.sessionOrder as unknown[]).map(String);
  }
  if (raw.sessionMeta && typeof raw.sessionMeta === "object") {
    out.sessionMeta = raw.sessionMeta as Record<string, SessionMeta>;
  }
  if (raw.ui && typeof raw.ui === "object") {
    out.ui = { ...DEFAULT_UI, ...(raw.ui as Partial<UISettings>) };
  }
  if (Array.isArray(raw.quickCommands)) {
    out.quickCommands = (raw.quickCommands as QuickCommand[]).filter(
      (c) => c && typeof c.label === "string" && typeof c.command === "string"
    );
  }
  if (Array.isArray(raw.sshProfiles)) {
    out.sshProfiles = (raw.sshProfiles as SshProfile[]).filter(
      (p) => p && typeof p.host === "string" && p.host.length > 0
    );
  }
  if (Array.isArray(raw.sessionsToRestore)) {
    out.sessionsToRestore = (raw.sessionsToRestore as SessionRestore[]).filter(
      (r) => r && typeof r.name === "string" && (r.kind === "shell" || r.kind === "agent")
    );
  }
  return out;
}

export function updateUI(patch: Partial<UISettings>) {
  cache.ui = { ...cache.ui, ...patch };
  scheduleSave();
}

export function updateQuickCommands(list: QuickCommand[]) {
  cache.quickCommands = list;
  scheduleSave();
}

export function updateSshProfiles(list: SshProfile[]) {
  cache.sshProfiles = list;
  scheduleSave();
}

export function upsertSessionMeta(name: string, patch: Partial<SessionMeta>) {
  const prev = cache.sessionMeta[name] ?? {
    name,
    kind: "shell" as SessionKind,
    color: null,
    sectionId: null,
  };
  cache.sessionMeta[name] = { ...prev, ...patch, name };
  scheduleSave();
}

export function removeSessionMeta(name: string) {
  delete cache.sessionMeta[name];
  scheduleSave();
}

export function renameSessionMeta(oldName: string, newName: string) {
  if (oldName === newName) return;
  const meta = cache.sessionMeta[oldName];
  if (meta) {
    delete cache.sessionMeta[oldName];
    cache.sessionMeta[newName] = { ...meta, name: newName };
  }
  const idx = cache.sessionOrder.indexOf(oldName);
  if (idx >= 0) cache.sessionOrder[idx] = newName;
  scheduleSave();
}

export function setSessionOrder(order: string[]) {
  cache.sessionOrder = order;
  scheduleSave();
}

export function setSessionsToRestore(list: SessionRestore[]) {
  cache.sessionsToRestore = list;
  scheduleSave();
}

export function addSection(name: string): SectionConfig {
  const id = `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const section: SectionConfig = { id, name, collapsed: false };
  // Insert before the tmux builtin so it stays last.
  const tmuxIdx = cache.sections.findIndex((s) => s.builtin === "tmux");
  if (tmuxIdx >= 0) cache.sections.splice(tmuxIdx, 0, section);
  else cache.sections.push(section);
  scheduleSave();
  return section;
}

export function removeSection(id: string) {
  if (id === "default") return;
  const sec = cache.sections.find((s) => s.id === id);
  if (!sec || sec.builtin) return;
  cache.sections = cache.sections.filter((s) => s.id !== id);
  for (const meta of Object.values(cache.sessionMeta)) {
    if (meta.sectionId === id) meta.sectionId = "default";
  }
  scheduleSave();
}

export function toggleSection(id: string) {
  const sec = cache.sections.find((s) => s.id === id);
  if (!sec) return;
  sec.collapsed = !sec.collapsed;
  scheduleSave();
}

export function renameSection(id: string, name: string) {
  const sec = cache.sections.find((s) => s.id === id);
  if (!sec || sec.builtin) return;
  sec.name = name;
  scheduleSave();
}
