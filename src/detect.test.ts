import { describe, it, expect } from "vitest";
import {
  looksLikeClaude,
  detectClaudeStatusFromScreen,
  detectOscNotifications,
  detectTmuxSession,
} from "./detect";

// ─── looksLikeClaude ─────────────────────────────────────────────────────────

describe("looksLikeClaude", () => {
  it("détecte 'Welcome to Claude Code'", () => {
    expect(looksLikeClaude("Welcome to Claude Code")).toBe(true);
  });

  it("détecte le pattern de raccourcis '? for shortcuts'", () => {
    expect(looksLikeClaude("Press ? for shortcuts")).toBe(true);
  });

  it("détecte le modèle dans le footer (Sonnet 4.6)", () => {
    expect(looksLikeClaude("Sonnet 4.6")).toBe(true);
  });

  it("détecte le modèle dans le footer (Opus 4.7)", () => {
    expect(looksLikeClaude("Opus 4.7")).toBe(true);
  });

  it("détecte un titre OSC avec Claude Code", () => {
    expect(looksLikeClaude('\x1b]0;Claude Code\x07')).toBe(true);
  });

  it("retourne false pour un écran shell ordinaire", () => {
    expect(looksLikeClaude("$ ls -la\ntotal 42\ndrwxr-xr-x 2 user user 4096")).toBe(false);
  });

  it("retourne false pour une chaîne vide", () => {
    expect(looksLikeClaude("")).toBe(false);
  });
});

// ─── detectClaudeStatusFromScreen ────────────────────────────────────────────

describe("detectClaudeStatusFromScreen", () => {
  it("retourne null pour un écran vide", () => {
    expect(detectClaudeStatusFromScreen("")).toBeNull();
  });

  it("retourne null pour un écran sans marqueur Claude", () => {
    expect(detectClaudeStatusFromScreen("$ echo hello\nhello\n$")).toBeNull();
  });

  it("retourne 'running' quand 'esc to interrupt' est visible", () => {
    expect(detectClaudeStatusFromScreen("Generating... esc to interrupt")).toBe("running");
  });

  it("retourne 'running' pour un spinner avec compteur de tokens", () => {
    expect(detectClaudeStatusFromScreen("(21s · ↑ 754 tokens)")).toBe("running");
  });

  it("retourne 'running' pour un verbe en -ing capitalisé suivi de …", () => {
    expect(detectClaudeStatusFromScreen("Thinking…")).toBe("running");
  });

  it("retourne 'waiting' quand Claude pose une question de confirmation", () => {
    const ecran = "Do you want to proceed?\n? for shortcuts";
    expect(detectClaudeStatusFromScreen(ecran)).toBe("waiting");
  });

  it("retourne 'idle' quand un marqueur de fin de turn est présent", () => {
    // Pattern : bullet + verbe au passé + durée
    const ecran = "• Worked for 3s\n? for shortcuts";
    expect(detectClaudeStatusFromScreen(ecran)).toBe("idle");
  });

  it("retourne 'idle' quand le footer Claude est visible sans running/waiting", () => {
    expect(detectClaudeStatusFromScreen("Sonnet 4.6")).toBe("idle");
  });

  it("running prend la priorité sur waiting quand les deux patterns sont présents", () => {
    const ecran = "esc to interrupt\nDo you want to proceed?";
    expect(detectClaudeStatusFromScreen(ecran)).toBe("running");
  });
});

// ─── detectOscNotifications ──────────────────────────────────────────────────

describe("detectOscNotifications", () => {
  it("retourne un tableau vide si aucune séquence OSC", () => {
    expect(detectOscNotifications("texte normal")).toEqual([]);
  });

  it("retourne un tableau vide pour une chaîne vide", () => {
    expect(detectOscNotifications("")).toEqual([]);
  });

  it("détecte une notification OSC 9 (iTerm2 style, terminée par BEL)", () => {
    const data = "\x1b]9;tâche terminée\x07";
    const résultat = detectOscNotifications(data);
    expect(résultat).toHaveLength(1);
    expect(résultat[0].channel).toBe("9");
    expect(résultat[0].body).toBe("tâche terminée");
  });

  it("détecte une notification OSC 99 (kitty style)", () => {
    const data = "\x1b]99;i=1:d=0;message\x07";
    const résultat = detectOscNotifications(data);
    expect(résultat).toHaveLength(1);
    expect(résultat[0].channel).toBe("99");
  });

  it("détecte plusieurs notifications OSC dans un même flux", () => {
    const data = "\x1b]9;premier\x07 texte \x1b]9;second\x07";
    const résultat = detectOscNotifications(data);
    expect(résultat).toHaveLength(2);
  });

  it("accepte la terminaison ST (ESC \\) en plus de BEL", () => {
    const data = "\x1b]9;avec ST\x1b\\";
    const résultat = detectOscNotifications(data);
    expect(résultat).toHaveLength(1);
    expect(résultat[0].body).toBe("avec ST");
  });
});

// ─── detectTmuxSession ───────────────────────────────────────────────────────

describe("detectTmuxSession", () => {
  it("retourne null pour une chaîne vide", () => {
    expect(detectTmuxSession("")).toBeNull();
  });

  it("retourne null si pas de séquence OSC de titre", () => {
    expect(detectTmuxSession("texte normal sans séquence")).toBeNull();
  });

  it("détecte un format explicite 'tmux:<session>'", () => {
    const data = "\x1b]2;tmux:ma-session\x07";
    expect(detectTmuxSession(data)).toBe("ma-session");
  });

  it("détecte un format implicite '<session>:<window>.<pane>'", () => {
    const data = "\x1b]2;projet:0.1 \x07";
    expect(detectTmuxSession(data)).toBe("projet");
  });

  it("détecte un format implicite '<session>:<window>'", () => {
    const data = "\x1b]2;dev:1 \x07";
    expect(detectTmuxSession(data)).toBe("dev");
  });

  it("retourne null si le titre OSC ne correspond pas au format tmux", () => {
    const data = "\x1b]2;bash\x07";
    expect(detectTmuxSession(data)).toBeNull();
  });
});
