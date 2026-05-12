# noobmux

GUI Linux pour gérer plusieurs terminaux et sessions Claude Code sans avoir à mémoriser les raccourcis tmux. Sidebar cliquable, statut visible, click-droit pour lancer une commande pré-définie.

> Pour les noob qui veulent juste voir ce qui tourne.

## État

MVP en cours. Ce qui marche :

- Terminaux PTY réels (portable-pty côté Rust, xterm.js côté front)
- Sidebar avec liste des sessions, click pour switcher, double-click ou `F2` pour renommer
- Boutons **+ Terminal** (shell par défaut) et **+ Claude** (lance `claude` directement)
- Click-droit sur une session → menu de commandes rapides (`pnpm dev`, `claude --continue`, `git status`, …) configurables dans `src/commands.ts`
- Indicateur de statut par session : idle / running / waiting / error
- Bridge hooks Claude Code via socket Unix (`scripts/noobmux-hook`) pour savoir quand un agent attend une réponse

Pas encore : worktrees git, profils SSH, persistance des sessions au reload, splits.

## Prérequis

- Rust (rustup, stable)
- Node 20+ et pnpm
- Libs système Linux : `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev pkg-config`

## Lancer en dev

```bash
pnpm install
pnpm tauri dev
```

Le premier `tauri dev` compile tout le côté Rust — compter quelques minutes.

## Brancher Claude Code

Ajouter dans `~/.claude/settings.json` :

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "/home/nico/Dev/noobmux/scripts/noobmux-hook Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "/home/nico/Dev/noobmux/scripts/noobmux-hook Notification" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/home/nico/Dev/noobmux/scripts/noobmux-hook UserPromptSubmit" }] }]
  }
}
```

Chaque session lancée par noobmux exporte `NOOBMUX_SESSION_ID` dans son env, ce qui permet au hook de savoir à quelle session le statut correspond. Le hook ne bloque jamais Claude Code — si noobmux n'est pas lancé, le script ne fait rien.

## Architecture

```
src/                  frontend (TypeScript + xterm.js)
  main.ts             point d'entrée, gestion des sessions
  session.ts          création d'un Terminal xterm + état
  contextMenu.ts      menu click-droit
  commands.ts         commandes rapides (édite ce fichier pour personnaliser)
src-tauri/
  src/lib.rs          entrée Tauri
  src/pty.rs          spawn/read/write/resize/kill via portable-pty
  src/hooks.rs        socket Unix pour les events Claude Code
scripts/noobmux-hook  bridge stdin JSON → socket Unix
```
