import { getConfig, updateQuickCommands, updateUI } from "./store";
import { THEMES, applyThemeToRoot, getTheme } from "./themes";
import type { QuickCommand } from "./commands";
import { checkForUpdate, showUpdateBanner } from "./updater";

declare const __APP_VERSION__: string;

export interface SettingsHooks {
  onChange: () => void;
}

export function openSettingsModal(hooks: SettingsHooks) {
  if (document.querySelector(".settings-overlay")) return;

  const cfg = getConfig();
  let working = {
    themeId: cfg.ui.themeId,
    fontSize: cfg.ui.fontSize,
    fontFamily: cfg.ui.fontFamily,
    quickCommands: cfg.quickCommands.map((c) => ({ ...c })) as QuickCommand[],
  };

  const overlay = el("div", "settings-overlay");
  const box = el("div", "settings-box");
  overlay.appendChild(box);

  // ── Header ────────────────────────────────────────────────────────────
  const header = el("div", "settings-header");
  header.append(text("h2", "Paramètres", "settings-title"));
  const closeBtn = el("button", "settings-close");
  closeBtn.textContent = "×";
  closeBtn.title = "Fermer";
  header.appendChild(closeBtn);
  box.appendChild(header);

  // ── Tabs ──────────────────────────────────────────────────────────────
  const tabs = el("div", "settings-tabs");
  const body = el("div", "settings-body");
  box.append(tabs, body);

  const tabDefs = [
    { id: "appearance", label: "Apparence" },
    { id: "commands", label: "Commandes rapides" },
    { id: "about", label: "À propos" },
  ];
  const panes: Record<string, HTMLElement> = {};
  for (const t of tabDefs) {
    const tab = el("button", "settings-tab");
    tab.textContent = t.label;
    tab.dataset.tabId = t.id;
    tab.addEventListener("click", () => setActiveTab(t.id));
    tabs.appendChild(tab);
    panes[t.id] = el("div", "settings-pane");
    body.appendChild(panes[t.id]);
  }

  function setActiveTab(id: string) {
    for (const t of tabs.querySelectorAll(".settings-tab")) {
      t.classList.toggle("active", (t as HTMLElement).dataset.tabId === id);
    }
    for (const [paneId, pane] of Object.entries(panes)) {
      pane.classList.toggle("active", paneId === id);
    }
  }
  setActiveTab("appearance");

  // ── Appearance pane ───────────────────────────────────────────────────
  buildAppearancePane(panes["appearance"], working, () => {
    updateUI({
      themeId: working.themeId,
      fontSize: working.fontSize,
      fontFamily: working.fontFamily,
    });
    applyThemeToRoot(getTheme(working.themeId));
    hooks.onChange();
  });

  // ── Commands pane ─────────────────────────────────────────────────────
  buildCommandsPane(panes["commands"], working, () => {
    updateQuickCommands(working.quickCommands);
  });

  // ── About pane ────────────────────────────────────────────────────────
  buildAboutPane(panes["about"]);

  // ── Footer ────────────────────────────────────────────────────────────
  const footer = el("div", "settings-footer");
  const doneBtn = el("button", "prompt-ok");
  doneBtn.textContent = "Terminé";
  footer.appendChild(doneBtn);
  box.appendChild(footer);

  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  doneBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function escClose(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", escClose);
    }
  });

  document.body.appendChild(overlay);
}

function buildAppearancePane(
  pane: HTMLElement,
  working: { themeId: string; fontSize: number; fontFamily: string },
  apply: () => void
) {
  pane.appendChild(text("h3", "Thème"));
  const themesGrid = el("div", "theme-grid");
  for (const t of THEMES) {
    const card = el("button", "theme-card");
    card.dataset.themeId = t.id;
    card.style.background = t.ui.bg;
    card.style.color = t.ui.fg;
    card.style.borderColor = t.id === working.themeId ? t.ui.accent : t.ui.border;
    card.innerHTML = `
      <div class="theme-card-name">${t.name}</div>
      <div class="theme-card-swatches">
        <span style="background:${t.term.red}"></span>
        <span style="background:${t.term.green}"></span>
        <span style="background:${t.term.yellow}"></span>
        <span style="background:${t.term.blue}"></span>
        <span style="background:${t.term.magenta}"></span>
        <span style="background:${t.term.cyan}"></span>
      </div>
    `;
    card.addEventListener("click", () => {
      working.themeId = t.id;
      for (const c of themesGrid.querySelectorAll<HTMLElement>(".theme-card")) {
        const isActive = c.dataset.themeId === t.id;
        const tt = THEMES.find((x) => x.id === c.dataset.themeId)!;
        c.style.borderColor = isActive ? tt.ui.accent : tt.ui.border;
      }
      apply();
    });
    themesGrid.appendChild(card);
  }
  pane.appendChild(themesGrid);

  pane.appendChild(text("h3", "Police"));

  const sizeRow = el("div", "settings-row");
  sizeRow.appendChild(text("label", "Taille"));
  const sizeValue = el("span", "settings-row-value");
  sizeValue.textContent = `${working.fontSize}px`;
  const sizeInput = el("input", "settings-slider") as HTMLInputElement;
  sizeInput.type = "range";
  sizeInput.min = "10";
  sizeInput.max = "22";
  sizeInput.step = "1";
  sizeInput.value = String(working.fontSize);
  sizeInput.addEventListener("input", () => {
    working.fontSize = parseInt(sizeInput.value, 10);
    sizeValue.textContent = `${working.fontSize}px`;
    apply();
  });
  sizeRow.append(sizeInput, sizeValue);
  pane.appendChild(sizeRow);

  const fontRow = el("div", "settings-row settings-row-stacked");
  fontRow.appendChild(text("label", "Famille"));
  const fontInput = el("input", "settings-input") as HTMLInputElement;
  fontInput.type = "text";
  fontInput.value = working.fontFamily;
  fontInput.placeholder = '"JetBrains Mono", monospace';
  let fontDebounce: number | null = null;
  fontInput.addEventListener("input", () => {
    if (fontDebounce !== null) clearTimeout(fontDebounce);
    fontDebounce = window.setTimeout(() => {
      working.fontFamily = fontInput.value.trim() || working.fontFamily;
      apply();
    }, 250);
  });
  fontRow.appendChild(fontInput);
  pane.appendChild(fontRow);

  const fontHint = el("div", "settings-hint");
  fontHint.textContent =
    "Mets le nom d'une police monospace installée sur ton système. Liste séparée par virgules pour fallback.";
  pane.appendChild(fontHint);
}

function buildCommandsPane(
  pane: HTMLElement,
  working: { quickCommands: QuickCommand[] },
  apply: () => void
) {
  pane.appendChild(text("h3", "Commandes rapides"));
  const hint = el("div", "settings-hint");
  hint.textContent =
    "Apparaissent dans le menu click-droit d'une session. Le label est ce que tu vois, la commande est ce qui est envoyée au terminal (avec un retour à la ligne).";
  pane.appendChild(hint);

  const list = el("div", "cmd-list");
  pane.appendChild(list);

  const render = () => {
    list.innerHTML = "";
    working.quickCommands.forEach((c, idx) => {
      const row = el("div", "cmd-row");

      const handle = el("span", "cmd-handle");
      handle.textContent = "⋮⋮";
      handle.title = "Glisse pour réordonner";
      row.appendChild(handle);

      const labelInput = el("input", "cmd-input cmd-label") as HTMLInputElement;
      labelInput.value = c.label;
      labelInput.placeholder = "Label";
      labelInput.addEventListener("input", () => {
        c.label = labelInput.value;
        apply();
      });

      const cmdInput = el("input", "cmd-input cmd-cmd") as HTMLInputElement;
      cmdInput.value = c.command;
      cmdInput.placeholder = "commande shell";
      cmdInput.addEventListener("input", () => {
        c.command = cmdInput.value;
        apply();
      });

      const up = el("button", "cmd-btn") as HTMLButtonElement;
      up.textContent = "↑";
      up.disabled = idx === 0;
      up.addEventListener("click", () => {
        if (idx === 0) return;
        const tmp = working.quickCommands[idx - 1];
        working.quickCommands[idx - 1] = working.quickCommands[idx];
        working.quickCommands[idx] = tmp;
        apply();
        render();
      });

      const down = el("button", "cmd-btn") as HTMLButtonElement;
      down.textContent = "↓";
      down.disabled = idx === working.quickCommands.length - 1;
      down.addEventListener("click", () => {
        if (idx >= working.quickCommands.length - 1) return;
        const tmp = working.quickCommands[idx + 1];
        working.quickCommands[idx + 1] = working.quickCommands[idx];
        working.quickCommands[idx] = tmp;
        apply();
        render();
      });

      const del = el("button", "cmd-btn cmd-del");
      del.textContent = "✕";
      del.title = "Supprimer";
      del.addEventListener("click", () => {
        working.quickCommands.splice(idx, 1);
        apply();
        render();
      });

      row.append(labelInput, cmdInput, up, down, del);
      list.appendChild(row);
    });
  };
  render();

  const add = el("button", "cmd-add");
  add.textContent = "+ Ajouter une commande";
  add.addEventListener("click", () => {
    working.quickCommands.push({ label: "Nouvelle commande", command: "" });
    apply();
    render();
  });
  pane.appendChild(add);
}

function buildAboutPane(pane: HTMLElement) {
  pane.appendChild(text("h3", "Version"));
  const v = el("div", "settings-row");
  v.appendChild(text("label", "noobmux"));
  const vTag = el("span", "settings-row-value");
  vTag.textContent = `v${__APP_VERSION__}`;
  v.appendChild(vTag);
  pane.appendChild(v);

  pane.appendChild(text("h3", "Mises à jour"));
  const status = el("div", "settings-hint");
  status.textContent = "noobmux vérifie automatiquement les mises à jour au démarrage.";
  pane.appendChild(status);

  const btn = el("button", "cmd-add") as HTMLButtonElement;
  btn.textContent = "Vérifier maintenant";
  btn.style.marginTop = "8px";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Vérification…";
    const update = await checkForUpdate({ silent: false });
    btn.disabled = false;
    btn.textContent = "Vérifier maintenant";
    if (update) {
      status.textContent = `Version ${update.version} disponible.`;
      showUpdateBanner(update);
    } else {
      status.textContent = "Vous êtes à jour.";
    }
  });
  pane.appendChild(btn);

  pane.appendChild(text("h3", "Liens"));
  const repoLink = el("a");
  (repoLink as HTMLAnchorElement).href = "https://github.com/nmolins/noobmux";
  (repoLink as HTMLAnchorElement).target = "_blank";
  repoLink.textContent = "github.com/nmolins/noobmux";
  repoLink.style.color = "var(--accent)";
  pane.appendChild(repoLink);
}

// ── helpers ───────────────────────────────────────────────────────────────
function el(tag: string, cls = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function text(tag: string, content: string, cls = ""): HTMLElement {
  const e = el(tag, cls);
  e.textContent = content;
  return e;
}
