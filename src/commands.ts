export interface QuickCommand {
  label: string;
  command: string;
  shortcut?: string;
}

export const DEFAULT_COMMANDS: QuickCommand[] = [
  { label: "pnpm dev", command: "pnpm dev" },
  { label: "pnpm install", command: "pnpm install" },
  { label: "pnpm build", command: "pnpm build" },
  { label: "claude", command: "claude" },
  { label: "claude --continue", command: "claude --continue" },
  { label: "git status", command: "git status" },
  { label: "git log --oneline -20", command: "git log --oneline -20" },
  { label: "clear", command: "clear" },
];
