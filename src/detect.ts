// Détecte si la sortie d'un terminal shell contient une signature de Claude Code
// (TUI ratatui qui s'initialise). On reste défensif: chaîne distinctive + fallback.

// Patterns qui passent même à travers tmux (qui filtre les titres OSC).
// On vise des éléments durables de la TUI ratatui de Claude Code.
const CLAUDE_PATTERNS: RegExp[] = [
  /Welcome to Claude Code/i,
  /\x1b\]0;.*Claude Code/i,
  /\x1b\]2;.*Claude Code/i,
  // Footer help line affichée par Claude Code en permanence
  /\? for shortcuts/i,
  // Bandeau "Tip:" / "Try" du démarrage
  /\bTry "[^"]{3,}" to/i,
  // Texte distinctif des prompts d'autorisation
  /Bypassing Permissions/i,
  // L'identifiant du modèle dans le footer ("Opus 4.7", "Sonnet 4.6"…)
  /\b(Opus|Sonnet|Haiku)\s+\d/,
];

export function looksLikeClaude(data: string): boolean {
  return CLAUDE_PATTERNS.some((re) => re.test(data));
}

// ─── Statut visuel Claude Code ──────────────────────────────────────────────
//
// Approche : on regarde un buffer glissant de la sortie récente et on cherche
// des indices visuels. Comme la TUI ratatui redraw souvent, on raisonne sur le
// rendu cumulé plutôt que sur un seul chunk.

export type ClaudeStatus = "running" | "waiting" | "idle";

// Patterns visuels qui apparaissent dans l'écran rendu de Claude Code.
// Compatible vanilla + forks "remote-control" / auto-mode.
const RUNNING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,
  /\btokens?\b.*\bsec/i,
  /\(esc\)/i,
  // Forks/fast-mode : n'importe quel verbe en -ing capitalisé suivi de … (ellipsis
  // Unicode … ou trois points ASCII). Couvre Thinking, Philosophising,
  // Cogitating, Synthesizing et tout futur verbe ajouté par les forks sans
  // qu'on ait à maintenir une liste.
  /\b[A-Z][a-z]+ing(?:…|\.{3})/,
  // Spinner avec compteur de tokens : "(21s · ↑ 754 tokens)"
  /\(\d+s\s*[·•].*tokens?\)/i,
];

const WAITING_PATTERNS: RegExp[] = [
  /Do you want to/i,
  /Yes,?\s+(and don't ask again|proceed|allow)/i,
  /Press\s+(Enter|Esc|Tab|y|n)\s+to\s+(continue|confirm|approve|reject)/i,
  /Continue\?/i,
];

// Marqueurs forts d'idle : Claude vient de terminer un turn.
// Patterns observés : "Worked for 3s", "Sautéed for 6s", "Cogitated for 10s"
// (verbes au passé + durée). Ce marqueur apparaît dans la zone de transcript,
// pas dans le footer permanent — donc présent seulement après un turn.
const IDLE_PATTERNS: RegExp[] = [
  /[•*✶✷·]\s+[A-ZÀ-Ý][a-zà-ÿ]+ed\s+for\s+\d+\s*[ms]/i,
  /[•*✶✷·]\s+\w+ed\s+for\s+\d+s\b/i,
];

/**
 * Analyse l'écran rendu (lignes visibles du terminal, pas le scrollback) pour
 * inférer le statut Claude. Contrairement au buffer brut, l'écran reflète
 * vraiment ce que l'utilisateur voit : si Claude efface "esc to interrupt"
 * quand il a fini, on ne le voit plus dans l'écran.
 */
// OSC notifications: séquences que les terminaux émettent pour notifier le
// terminal hôte qu'un agent attend une action ou a fini.
//   OSC 9 ; <msg> BEL          (iTerm2/cmux)
//   OSC 99 ; <meta> ; <msg> BEL (kitty)
//   OSC 777 ; notify ; <title> ; <body> BEL  (rxvt-unicode style)
const OSC_NOTIFY_RE = /\x1b\](9|99|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface OscNotification {
  channel: "9" | "99" | "777";
  body: string;
}

export function detectOscNotifications(data: string): OscNotification[] {
  OSC_NOTIFY_RE.lastIndex = 0;
  const out: OscNotification[] = [];
  let m: RegExpExecArray | null;
  while ((m = OSC_NOTIFY_RE.exec(data)) !== null) {
    out.push({ channel: m[1] as "9" | "99" | "777", body: m[2] });
  }
  return out;
}

export function detectClaudeStatusFromScreen(screen: string): ClaudeStatus | null {
  // Ordre important : running > waiting > idle.
  // Running gagne car Claude peut afficher des prompts pendant qu'il génère.
  if (RUNNING_PATTERNS.some((re) => re.test(screen))) return "running";
  // Waiting : on filtre les faux positifs (shift+tab to cycle apparaît aussi en idle)
  const hasWaiting = WAITING_PATTERNS.some((re) => re.test(screen));
  const hasIdle = IDLE_PATTERNS.some((re) => re.test(screen));
  if (hasWaiting && !hasIdle) return "waiting";
  if (hasIdle) return "idle";
  // Footer Claude visible mais ni running ni waiting : on est idle.
  // Évite que "waiting" reste figé après qu'un prompt OSC ait été dismissé.
  if (/\? for shortcuts/i.test(screen) || /\b(Opus|Sonnet|Haiku)\s+\d/.test(screen)) {
    return "idle";
  }
  return null;
}

// tmux émet régulièrement une séquence OSC pour le titre de la fenêtre quand
// `set -g set-titles on`. Format typique:
//   ESC ] 2 ; <session>:<window>.<pane> ... BEL
// ou  ESC ] 0 ; ... BEL
// On capture le nom de session si le titre commence par "tmux:" ou si on
// reconnait le format "<session>:<window>.<pane>".
const TMUX_TITLE_RE = /\x1b\]([02]);([^\x07\x1b]*)(\x07|\x1b\\)/g;

export function detectTmuxSession(data: string): string | null {
  TMUX_TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TMUX_TITLE_RE.exec(data)) !== null) {
    const title = m[2];
    // Format explicite "tmux:<session>"
    const explicit = /^tmux:([^:\s]+)/.exec(title);
    if (explicit) return explicit[1];
    // Format implicite <session>:<window>.<pane> ou <session>:<window>
    const implicit = /^([^\s:]+):\d+(?:\.\d+)?(?:\s|$|\s\*|\s-)/.exec(title);
    if (implicit) return implicit[1];
  }
  return null;
}
