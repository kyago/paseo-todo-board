import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Mirrors the daemon's `resolvePaseoHome`, including a literal `~` left unexpanded by a service manager. */
export function paseoHome(): string {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  if (raw === "~") return homedir();
  return resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

export const dataDir = () => join(paseoHome(), "plugin-data", "todo-board");
export const boardFile = () => join(dataDir(), "board.json");
export const inboxDir = () => join(dataDir(), "inbox");
export const mcpScriptFile = () => join(dataDir(), "mcp.mjs");
