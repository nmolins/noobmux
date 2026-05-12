import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { getConfig } from "./store";
import { getTheme } from "./themes";

export type SessionKind = "shell" | "agent";
export type SessionStatus = "idle" | "running" | "waiting" | "error";

export interface Session {
  id: string;
  name: string;
  kind: SessionKind;
  status: SessionStatus;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement;
  lastOutputAt: number;
}

export function createSession(opts: {
  id: string;
  name: string;
  kind: SessionKind;
  container: HTMLElement;
}): Session {
  const cfg = getConfig();
  const theme = getTheme(cfg.ui.themeId);
  const term = new Terminal({
    fontFamily: cfg.ui.fontFamily,
    fontSize: cfg.ui.fontSize,
    cursorBlink: true,
    theme: theme.term,
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // Bug WebKit2GTK + AZERTY : pour une touche directe non-ASCII (é, à, è, ç…),
  // WebKit envoie keydown { keyCode:229 } (sentinel IME) puis plusieurs events
  // `input` sur le textarea xterm → caractère envoyé 2-3× au PTY.
  // Workaround : bloquer le keydown 229 dans xterm, capturer le 1er event
  // `input` sur le textarea (qui contient le caractère résolu), l'émettre
  // immédiatement, et bloquer les events `input` suivants jusqu'au prochain
  // keydown. Émettre dès le 1er input → pas de latence vs taper au keyup.
  // Voir tauri#3136, xterm.js#5348.
  let composingNonAscii = false;
  let firstInputConsumed = false;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.keyCode === 229) {
      composingNonAscii = true;
      firstInputConsumed = false;
      return false;
    }
    // Shift+Enter : émet une séquence "newline littéral" (\x1b\r) que les TUI
    // modernes comme Claude Code reconnaissent pour insérer une nouvelle ligne
    // dans le prompt au lieu d'envoyer. WebKit ne génère pas cet input par
    // défaut donc on le force.
    if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      term.input("\x1b\r", true);
      return false;
    }
    return true;
  });

  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.dataset.sessionId = opts.id;
  opts.container.appendChild(pane);

  term.open(pane);

  // Pendant la phase de composition non-ASCII, le textarea reçoit 2-3 events
  // `input` avec le même caractère. On capte le 1er, on l'émet directement
  // au PTY, et on bloque la propagation des suivants pour que xterm ne
  // double pas. Le flag se reset au prochain keydown.
  requestAnimationFrame(() => {
    const ta = pane.querySelector("textarea.xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.addEventListener(
      "input",
      (ev) => {
        if (!composingNonAscii) return;
        const inputEv = ev as InputEvent;
        if (!firstInputConsumed && inputEv.data) {
          firstInputConsumed = true;
          term.input(inputEv.data, true);
        }
        ev.stopImmediatePropagation();
        ta.value = "";
      },
      true
    );
  });

  term.onData((data) => {
    invoke("write_to_terminal", { id: opts.id, data }).catch(console.error);
  });

  term.onResize(({ cols, rows }) => {
    invoke("resize_terminal", { id: opts.id, cols, rows }).catch(console.error);
  });

  return {
    id: opts.id,
    name: opts.name,
    kind: opts.kind,
    status: "idle",
    term,
    fit,
    pane,
    lastOutputAt: Date.now(),
  };
}

const PROMPT_PATTERNS = [
  /\$\s*$/,
  /❯\s*$/,
  /»\s*$/,
  /#\s*$/,
  />\s*$/,
];

export function inferStatusFromOutput(prev: SessionStatus, data: string): SessionStatus {
  // Strip ANSI sequences for simple pattern check.
  const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trimEnd();
  if (!clean) return prev;
  for (const re of PROMPT_PATTERNS) {
    if (re.test(clean)) return "idle";
  }
  return "running";
}
