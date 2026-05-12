import type { ITheme } from "@xterm/xterm";

export interface ThemePreset {
  id: string;
  name: string;
  /** CSS variables applied to :root for the UI chrome. */
  ui: {
    bg: string;
    bgElev: string;
    bgSidebar: string;
    fg: string;
    fgMuted: string;
    accent: string;
    accentDim: string;
    border: string;
  };
  /** Theme passed to xterm. */
  term: ITheme;
}

export const THEMES: ThemePreset[] = [
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    ui: {
      bg: "#1a1b26",
      bgElev: "#16161e",
      bgSidebar: "#13141a",
      fg: "#c0caf5",
      fgMuted: "#565f89",
      accent: "#7aa2f7",
      accentDim: "#3d59a1",
      border: "#292e42",
    },
    term: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    ui: {
      bg: "#1e1e2e",
      bgElev: "#181825",
      bgSidebar: "#11111b",
      fg: "#cdd6f4",
      fgMuted: "#6c7086",
      accent: "#89b4fa",
      accentDim: "#45475a",
      border: "#313244",
    },
    term: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    ui: {
      bg: "#282828",
      bgElev: "#1d2021",
      bgSidebar: "#1d2021",
      fg: "#ebdbb2",
      fgMuted: "#928374",
      accent: "#fabd2f",
      accentDim: "#665c54",
      border: "#3c3836",
    },
    term: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      black: "#3c3836",
      red: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      blue: "#83a598",
      magenta: "#d3869b",
      cyan: "#8ec07c",
      white: "#ebdbb2",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    ui: {
      bg: "#002b36",
      bgElev: "#073642",
      bgSidebar: "#001f27",
      fg: "#93a1a1",
      fgMuted: "#586e75",
      accent: "#268bd2",
      accentDim: "#073642",
      border: "#073642",
    },
    term: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    ui: {
      bg: "#282c34",
      bgElev: "#21252b",
      bgSidebar: "#1c1f24",
      fg: "#abb2bf",
      fgMuted: "#5c6370",
      accent: "#61afef",
      accentDim: "#3e4451",
      border: "#3e4451",
    },
    term: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#abb2bf",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
    },
  },
];

export function applyThemeToRoot(t: ThemePreset) {
  const r = document.documentElement.style;
  r.setProperty("--bg", t.ui.bg);
  r.setProperty("--bg-elev", t.ui.bgElev);
  r.setProperty("--bg-sidebar", t.ui.bgSidebar);
  r.setProperty("--fg", t.ui.fg);
  r.setProperty("--fg-muted", t.ui.fgMuted);
  r.setProperty("--accent", t.ui.accent);
  r.setProperty("--accent-dim", t.ui.accentDim);
  r.setProperty("--border", t.ui.border);
}

export function getTheme(id: string): ThemePreset {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
