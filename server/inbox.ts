import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type InboxMessage, InboxMessageSchema } from "../shared/board.ts";

export interface InboxEntry {
  file: string;
  message: InboxMessage;
}

/** Reads every message the MCP server dropped. Files that are not valid messages are deleted so they cannot wedge the board. */
export async function readInbox(dir: string): Promise<InboxEntry[]> {
  await mkdir(dir, { recursive: true });
  const entries: InboxEntry[] = [];
  for (const name of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const file = join(dir, name);
    try {
      const parsed = InboxMessageSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.success) entries.push({ file, message: parsed.data });
      else {
        console.error(`[todo-board] inbox ${name} ignored: ${parsed.error.message}`);
        await unlink(file).catch(() => {});
      }
    } catch (error) {
      console.error(`[todo-board] inbox ${name} unreadable:`, error);
      await unlink(file).catch(() => {});
    }
  }
  return entries;
}

export const consume = (entry: InboxEntry) => unlink(entry.file).catch(() => {});
