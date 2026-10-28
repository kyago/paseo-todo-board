import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type Card, CardSchema } from "../shared/board.ts";

const FileSchema = z.object({ cards: z.array(CardSchema) });

/** All cards of this daemon in one JSON file, written atomically. Small enough to keep in memory. */
export class BoardStore {
  private cards: Card[] = [];
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (parsed.success) this.cards = parsed.data.cards;
      else console.error("[todo-board] board.json ignored:", parsed.error.message);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[todo-board] board.json unreadable:", error);
    }
  }

  all(): Card[] {
    return this.cards;
  }

  get(id: string): Card | undefined {
    return this.cards.find((card) => card.id === id);
  }

  /** Cards of a workspace; a card added from an agent knows only its cwd, so the root matches too. */
  list(workspaceId: string, root: string | null): Card[] {
    return this.cards.filter((card) => card.workspaceId === workspaceId || (root !== null && card.cwd === root));
  }

  byAgent(agentId: string): Card | undefined {
    return this.cards.find((card) => card.agentId === agentId || card.reviewerId === agentId);
  }

  async upsert(card: Card): Promise<Card> {
    const index = this.cards.findIndex((item) => item.id === card.id);
    if (index === -1) this.cards.push(card);
    else this.cards[index] = card;
    await this.save();
    return card;
  }

  async remove(id: string): Promise<void> {
    this.cards = this.cards.filter((card) => card.id !== id);
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify({ cards: this.cards }, null, 2);
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, snapshot);
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.chain;
  }
}
