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

**Voie recommandée** : ouvrir les réglages (icône ⚙ en bas de la sidebar) puis cliquer sur **Installer les hooks**. L'app détecte l'exécutable noobmux courant et écrit automatiquement les entrées nécessaires dans `~/.claude/settings.json`.

**Config manuelle** : si vous préférez, ajoutez les hooks vous-même en pointant vers l'exécutable noobmux installé sur votre machine :

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<chemin/vers/noobmux> --hook UserPromptSubmit" }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "<chemin/vers/noobmux> --hook PreToolUse" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "<chemin/vers/noobmux> --hook PostToolUse" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "<chemin/vers/noobmux> --hook Stop" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "<chemin/vers/noobmux> --hook Notification" }] }]
  }
}
```

Chaque session lancée par noobmux exporte `NOOBMUX_SESSION_ID` dans son env, ce qui permet au hook de savoir à quelle session le statut correspond. Les hooks ne bloquent jamais Claude Code — si noobmux n'est pas lancé, le relais ne fait rien.

> `scripts/noobmux-hook` (pont Python inclus dans le repo) reste une alternative valable si vous ne voulez pas utiliser l'exécutable principal comme pont.

## Architecture

**TypeScript (`src/`)**

- `main.ts` — point d'entrée : cycle de vie des sessions, rendu sidebar, wiring des events (`pty:output`, `pty:exit`, `agent:event`), boucles de polling statut/metadata.
- `session.ts` — fabrique un `Session` (Terminal xterm + addons fit/web-links), workaround saisie accentuée WebKit2GTK, Shift+Enter en TUI, synchro de taille.
- `store.ts` — état persistant (sections, ordre, metadata par session, UI, quick commands) ; load/save via commandes Tauri.
- `detect.ts` — heuristiques de détection (Claude à l'écran, statut visuel running/waiting/idle, notifications OSC, session tmux).
- `themes.ts` / `colors.ts` — thèmes de terminal et palette de couleurs.
- `contextMenu.ts` — menu clic-droit sur une session.
- `settingsModal.ts` — modale de réglages (police, thème, quick commands, installation hooks Claude).
- `commands.ts` — commandes rapides par défaut (éditez ce fichier pour personnaliser).
- `prompt.ts` — petite modale de saisie de texte (renommage, etc.).
- `updater.ts` — bannière de mise à jour + téléchargement/ouverture du `.deb`.

**Rust (`src-tauri/src/`)**

- `lib.rs` — point d'entrée Tauri : enregistrement des plugins et commandes, démarrage du listener de hooks ; `hook_cli` (`noobmux --hook <event>`) relaie les payloads Claude Code vers la socket.
- `main.rs` — binaire mince appelant `lib::run`.
- `pty.rs` — spawn/read/write/resize/kill des PTY via portable-pty ; thread lecteur avec réassemblage UTF-8 aux frontières de chunk.
- `meta.rs` — introspection runtime via /proc : foreground le plus profond, cwd réel, branche git, ports en écoute, `kill_process_tree`.
- `claude.rs` — lecture des fichiers de session Claude (`~/.claude/sessions/*.json`) pour récupérer le nom de session.
- `claude_hooks.rs` — installe/vérifie les hooks dans `~/.claude/settings.json` ; events couverts : UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification.
- `hooks.rs` — listener du socket Unix qui reçoit les events relayés et les ré-émet en `agent:event` vers le frontend.
- `tmux.rs` — liste/kill des sessions tmux via la CLI `tmux`.
- `config.rs` — load/save de `~/.config/noobmux/config.json` (écriture atomique tmp+rename).
- `download.rs` — téléchargement du `.deb` de l'updater (restreint au domaine GitHub).

**Scripts**

- `scripts/noobmux-hook` — pont Python (alternative manuelle) : lit le payload JSON sur stdin et le relaie sur la socket Unix.
