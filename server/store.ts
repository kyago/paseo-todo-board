import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type Card, CardSchema } from "../shared/board.ts";
import { transitions } from "./machine.ts";

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
    return this.cards.find((card) => card.agentId === agentId || card.reviewers.some((reviewer) => reviewer.agentId === agentId));
  }

  /** Ratings and the timeline change only through `annotate`, so a copy read before a long await (a PR push) cannot erase them. */
  async upsert(card: Card): Promise<Card> {
    const index = this.cards.findIndex((item) => item.id === card.id);
    const prev = this.cards[index];
    const next = prev ? { ...card, userRating: prev.userRating, aiRating: prev.aiRating, aiRaterId: prev.aiRaterId, events: [...prev.events, ...transitions(prev, card)] } : card;
    if (index === -1) this.cards.push(next);
    else this.cards[index] = next;
    await this.save();
    return next;
  }

  async annotate(id: string, patch: Partial<Pick<Card, "userRating" | "aiRating" | "aiRaterId" | "events">>): Promise<Card | null> {
    const index = this.cards.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const next = { ...this.cards[index], ...patch, updatedAt: new Date().toISOString() };
    this.cards[index] = next;
    await this.save();
    return next;
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
