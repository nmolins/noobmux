import { getConfig } from "./store";
import { PALETTE } from "./colors";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  shortcut?: string;
}

export interface ContextMenuOpts {
  x: number;
  y: number;
  sectionChoices?: { id: string; name: string; current: boolean }[];
  closeLabel?: string;
  customItems?: ContextMenuItem[];
  onRun?: (cmd: string) => void;
  onRename?: () => void;
  onClose?: () => void;
  onKillTmux?: () => void;
  onColor?: (hex: string | null) => void;
  onMoveTo?: (sectionId: string) => void;
}

export function showContextMenu(opts: ContextMenuOpts) {
  const menu = document.getElementById("context-menu") as HTMLDivElement;
  menu.innerHTML = "";

  const addItem = (label: string, onClick: () => void, shortcut?: string) => {
    const item = document.createElement("div");
    item.className = "context-menu-item";
    item.innerHTML = `<span>${label}</span>${
      shortcut ? `<span class="context-menu-shortcut">${shortcut}</span>` : ""
    }`;
    item.addEventListener("click", () => {
      hideContextMenu();
      onClick();
    });
    menu.appendChild(item);
  };

  const addSep = () => {
    const s = document.createElement("div");
    s.className = "context-menu-separator";
    menu.appendChild(s);
  };

  const addLabel = (label: string) => {
    const el = document.createElement("div");
    el.className = "context-menu-label";
    el.textContent = label;
    menu.appendChild(el);
  };

  if (opts.customItems) {
    for (const it of opts.customItems) addItem(it.label, it.onClick, it.shortcut);
  }
  if (opts.onRename) addItem("Renommer", opts.onRename, "F2");
  if (opts.onClose) addItem(opts.closeLabel ?? "Fermer", opts.onClose);
  if (opts.onKillTmux) addItem("Tuer la session tmux", opts.onKillTmux);

  if (opts.onColor) {
    addSep();
    addLabel("Couleur");
    const swatches = document.createElement("div");
    swatches.className = "context-menu-swatches";
    for (const c of PALETTE) {
      const dot = document.createElement("button");
      dot.className = "swatch";
      dot.title = c.label;
      if (c.hex) dot.style.background = c.hex;
      else dot.classList.add("swatch-none");
      dot.addEventListener("click", () => {
        hideContextMenu();
        opts.onColor?.(c.hex || null);
      });
      swatches.appendChild(dot);
    }
    menu.appendChild(swatches);
  }

  if (opts.onMoveTo && opts.sectionChoices && opts.sectionChoices.length > 0) {
    addSep();
    addLabel("Déplacer dans");
    for (const sec of opts.sectionChoices) {
      addItem(`${sec.current ? "✓ " : "  "}${sec.name}`, () => opts.onMoveTo!(sec.id));
    }
  }

  if (opts.onRun) {
    const cmds = getConfig().quickCommands;
    if (cmds.length > 0) {
      addSep();
      addLabel("Commandes rapides");
      for (const c of cmds) {
        addItem(c.label, () => opts.onRun!(c.command), c.shortcut);
      }
    }
  }

  menu.classList.remove("hidden");
  menu.style.left = `${opts.x}px`;
  menu.style.top = `${opts.y}px`;

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - r.width - 6}px`;
    }
    if (r.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - r.height - 6}px`;
    }
  });

  const onDocClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) hideContextMenu();
  };
  setTimeout(() => document.addEventListener("click", onDocClick, { once: true }), 0);
}

export function hideContextMenu() {
  const menu = document.getElementById("context-menu");
  menu?.classList.add("hidden");
}
