import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { getConfig } from "./store";
import { getTheme } from "./themes";

export type SessionKind = "shell" | "agent";
export type SessionStatus = "idle" | "running" | "waiting" | "done" | "error" | "ssh";

export interface Session {
  id: string;
  /** Nom interne stable : clé de persistance (couleur, section, ordre). Pour
   *  une session Claude, le libellé AFFICHÉ est dérivé via displayName() et non
   *  ce champ — voir claudeName. */
  name: string;
  /** Nom de la session côté Claude Code (champ `name` de
   *  ~/.claude/sessions/<pid>.json, posé par /title). undefined si la session
   *  n'est pas (encore) une session Claude ou n'a pas été nommée. Le libellé
   *  affiché devient alors « Claude » ou « Claude : <claudeName> ». */
  claudeName?: string;
  kind: SessionKind;
  status: SessionStatus;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLDivElement;
  lastOutputAt: number;
  /** Observe les changements de taille du pane pour re-fit sans rater un cas
   *  (ouverture/fermeture sidebar, layout, transition CSS…). Voir syncSize. */
  resizeObserver: ResizeObserver;
  /** Recalcule la grille xterm depuis la taille du pane, notifie le PTY si
   *  cols/rows ont réellement changé, et nettoie les résidus. No-op si le pane
   *  n'est pas encore layouté (largeur 0). */
  syncSize: () => void;
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

  // Bug WebKit2GTK + AZERTY : la saisie non-ASCII passe par une composition IME
  // (keydown { keyCode:229 } sentinel) que xterm gère mal → caractère doublé.
  //  - Touche directe (é, à, è, ç…) : 1 keydown 229 + events `input`.
  //  - Touche morte (^ puis e → ê) : 2 keydown 229, un `input` provisoire
  //    portant le « ^ » puis un `input` final portant le « ê ».
  // Workaround : bloquer le keydown 229 dans xterm, et sur le textarea ne
  // retenir que l'event `input` FINAL (inputType insertFromComposition /
  // insertText), en ignorant le « ^ » provisoire. Voir le handler `input`
  // plus bas. tauri#3136, xterm.js#5348.
  let composingNonAscii = false;
  let firstInputConsumed = false;
  // Comm du process foreground (mis à jour par le poll meta côté main.ts).
  // Sert à décider quoi envoyer pour Shift+Enter : séquence étendue dans une
  // TUI moderne, Enter classique dans un shell.
  let foregroundComm: string | undefined = undefined;
  const SHELL_COMMS = new Set([
    "bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish",
  ]);
  (term as any).__noobmux_setForegroundComm = (c: string | undefined) => {
    foregroundComm = c;
  };
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
    // Shift+Enter : si le foreground n'est pas un shell, on envoie la séquence
    // CSI 27;2;13~ (modifyOtherKeys lvl 2) que Claude Code et autres TUI
    // reconnaissent. Si c'est un shell ou inconnu, on laisse passer Enter
    // normal pour ne pas polluer la ligne avec des caractères bruts.
    if (
      e.type === "keydown" &&
      e.key === "Enter" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      if (foregroundComm && !SHELL_COMMS.has(foregroundComm.toLowerCase())) {
        // kitty keyboard protocol: CSI <key>;<modifiers> u (13=Enter, 2=Shift).
        // Claude Code et autres TUI modernes reconnaissent cette séquence.
        // preventDefault pour éviter que WebKit envoie aussi un Enter brut.
        term.input("\x1b[13;2u", true);
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Sinon (shell), laisser Enter classique passer.
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
        // Discriminer via inputType (vérifié sur WebKit2GTK + AZERTY) :
        //  - "insertCompositionText" → texte PROVISOIRE : pour une touche morte
        //    (^ puis e) c'est le « ^ » d'aperçu. Ne PAS l'émettre, sinon on
        //    obtient « ^ê » au lieu de « ê ».
        //  - "insertFromComposition" / "insertText" → caractère FINAL résolu
        //    (ê, é, à…). C'est lui qu'on envoie au PTY.
        // Les touches directes (é, à) n'émettent qu'un seul input, déjà de type
        // "insertFromComposition" → comportement inchangé pour elles.
        const isFinal =
          inputEv.inputType === "insertFromComposition" ||
          inputEv.inputType === "insertText";
        if (isFinal && !firstInputConsumed && inputEv.data) {
          firstInputConsumed = true;
          term.input(inputEv.data, true);
        }
        // Stopper TOUS les events input (y compris le ^ provisoire) pour que
        // xterm ne double pas / n'insère pas le caractère mort.
        ev.stopImmediatePropagation();
        ta.value = "";
      },
      true
    );
  });

  term.onData((data) => {
    invoke("write_to_terminal", { id: opts.id, data }).catch(console.error);
  });

  // term.onResize ne se déclenche QUE quand cols/rows changent réellement.
  // C'est donc le seul endroit qui notifie le PTY — et après le reflow xterm,
  // on force un repaint pour effacer les résidus laissés par l'ancienne grille
  // (spinner « Booping… » collé, cadre de prompt mal wrappé…).
  term.onResize(({ cols, rows }) => {
    invoke("resize_terminal", { id: opts.id, cols, rows }).catch(console.error);
    term.refresh(0, term.rows - 1);
  });

  // Recalcule la grille depuis la taille du pane. fit() ne déclenche onResize
  // que si la taille a changé → pas de boucle avec le ResizeObserver, pas de
  // spam du PTY. No-op tant que le pane n'est pas layouté (offsetWidth 0),
  // p. ex. créé dans un onglet inactif — l'observer rappellera au bon moment.
  // Debounce : pendant un drag de sidebar, le pane change de taille en rafale.
  // On laisse xterm reflow en continu (fluide visuellement) mais on attend
  // ~120 ms de stabilité avant de notifier le PTY, pour ne pas le spammer.
  // syncSize est rappelé en trailing edge → l'état final est toujours synchro.
  let debounceTimer: number | undefined;

  const syncSize = () => {
    if (pane.offsetWidth === 0 || pane.offsetHeight === 0) return;
    // Un fit synchrone rend tout fit debouncé en attente redondant : on l'annule
    // pour éviter un 2e recalage ~120 ms plus tard (saccade visible lors d'un
    // changement de layout discret : épingler/désépingler, changer d'onglet).
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    fit.fit();
  };

  const debouncedSync = () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(syncSize, 120);
  };

  const resizeObserver = new ResizeObserver(debouncedSync);
  resizeObserver.observe(pane);

  // Fit dès que le pane a une taille réelle, avant tout rendu du process.
  requestAnimationFrame(syncSize);

  return {
    id: opts.id,
    name: opts.name,
    kind: opts.kind,
    status: "idle",
    term,
    fit,
    pane,
    lastOutputAt: Date.now(),
    resizeObserver,
    syncSize,
  };
}

