# CLAUDE.md — Guide de développement noobmux

## Vue d'ensemble

noobmux est une application de bureau **Linux** construite avec **Tauri 2** (backend Rust, frontend TypeScript + xterm.js). Elle propose une interface graphique pour gérer plusieurs terminaux PTY et sessions Claude Code depuis une sidebar cliquable, sans avoir à mémoriser les raccourcis tmux.

## Carte du code

### TypeScript (`src/`)

| Fichier | Rôle |
|---|---|
| `main.ts` | Point d'entrée : cycle de vie des sessions, rendu sidebar, wiring des events (`pty:output`, `pty:exit`, `agent:event`), boucles de polling statut/metadata. |
| `session.ts` | Fabrique un `Session` (Terminal xterm + addons fit/web-links), workaround saisie accentuée WebKit2GTK, Shift+Enter en TUI, synchro de taille. |
| `store.ts` | État persistant (sections, ordre, metadata par session, UI, quick commands) ; load/save via commandes Tauri. |
| `detect.ts` | Heuristiques de détection (Claude à l'écran, statut visuel running/waiting/idle, notifications OSC, session tmux). |
| `themes.ts` / `colors.ts` | Thèmes de terminal et palette de couleurs. |
| `contextMenu.ts` | Menu clic-droit sur une session. |
| `settingsModal.ts` | Modale de réglages (police, thème, quick commands, installation hooks Claude). |
| `commands.ts` | Commandes rapides par défaut. |
| `prompt.ts` | Petite modale de saisie de texte. |
| `updater.ts` | Bannière de mise à jour + téléchargement/ouverture du `.deb`. |

### Rust (`src-tauri/src/`)

| Fichier | Rôle |
|---|---|
| `lib.rs` | Point d'entrée Tauri : plugins, commandes, démarrage du listener de hooks ; `hook_cli` (`noobmux --hook <event>`) relaie vers la socket. |
| `main.rs` | Binaire mince appelant `lib::run`. |
| `pty.rs` | Spawn/read/write/resize/kill des PTY via portable-pty ; thread lecteur avec réassemblage UTF-8 aux frontières de chunk. |
| `meta.rs` | Introspection runtime via /proc : foreground le plus profond, cwd réel, branche git, ports en écoute, `kill_process_tree`. |
| `claude.rs` | Lecture des fichiers de session Claude (`~/.claude/sessions/*.json`) pour récupérer le nom de session. |
| `claude_hooks.rs` | Installe/vérifie les hooks dans `~/.claude/settings.json` (events : UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification). |
| `hooks.rs` | Listener du socket Unix qui reçoit les events relayés et les ré-émet en `agent:event` vers le frontend. |
| `tmux.rs` | Liste/kill des sessions tmux via la CLI `tmux`. |
| `config.rs` | Load/save de `~/.config/noobmux/config.json` (écriture atomique tmp+rename). |
| `download.rs` | Téléchargement du `.deb` de l'updater (restreint au domaine GitHub). |

### Flux des hooks Claude Code

```
Claude Code (event)
  → noobmux --hook <event>   (lib.rs : hook_cli, lit stdin JSON)
  → socket Unix              (hooks.rs : listener)
  → agent:event              (émis vers le frontend Tauri)
  → main.ts                  (handler : détection statut, nom session, sidebar)
```

## Commandes

```bash
# Développement
pnpm tauri dev

# Vérification TypeScript
npx tsc --noEmit

# Tests
pnpm test                   # tests TS (vitest)
cd src-tauri && cargo test  # tests Rust

# Vérification globale (lint + typecheck + tests)
pnpm check

# Build et release
scripts/release.sh          # TOUJOURS utiliser ce script
```

> **Ne jamais créer de tag git ou de GitHub Release à la main.** L'updater Tauri exige une GitHub Release signée avec les artefacts produits par le workflow CI. `scripts/release.sh` orchestre tout cela correctement.

## Conventions

- **Langue** : commentaires et UI en français.
- **TypeScript strict** : `noUnusedLocals` et `noUnusedParameters` activés — tout symbol inutilisé est une erreur de compilation.
- **Commandes Tauri** : renvoient `Result<_, String>` (l'erreur est un message lisible, pas un type structuré).
- **Hooks** : ne doivent jamais bloquer ni crasher Claude Code. Échec silencieux obligatoire — si noobmux n'est pas lancé, le relais ne fait rien.

## Pièges connus

### 1. Persistance par nom (IDs éphémères)

Les métadonnées de session (nom, section, ordre) sont persistées **par nom**, pas par ID. Les IDs sont ephémères et recréés à chaque lancement.

L'unicité du nom est garantie à la **création** ET au **renommage** via `uniqueName(base, excludeId?)` dans `src/main.ts` (l'appel au renommage passe `excludeId = s.id` pour ne pas compter la session elle-même). Si vous touchez à la logique de renommage, préservez ce mécanisme pour éviter les collisions silencieuses.

### 2. Workaround saisie accentuée WebKit2GTK + AZERTY

`src/session.ts` contient un workaround pour un bug WebKit2GTK où les caractères non-ASCII passent par une composition IME et arrivent en double (é → ééé) ou via des touches mortes (^ê). **Ne pas supprimer ni « simplifier » ce code sans avoir compris et testé le bug** sur un vrai clavier AZERTY sous WebKit2GTK.

### 3. Réassemblage UTF-8 aux frontières de chunk dans `pty.rs`

Le thread lecteur de PTY maintient un `carry` buffer pour réassembler les caractères UTF-8 coupés aux frontières de lecture. Briser ce mécanisme produit des artefacts : caractères de box-drawing corrompus, spinners résiduels, lignes décalées. Toute modification du chemin de lecture dans `pty.rs` doit préserver ce carry buffer.
