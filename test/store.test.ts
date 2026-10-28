import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consume, readInbox } from "../server/inbox.ts";
import { newCard } from "../server/machine.ts";
import { BoardStore } from "../server/store.ts";

test("the store round-trips cards through its JSON file and lists by workspace or root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-board-"));
  const store = new BoardStore(join(dir, "board.json"));
  await store.load();
  const a = await store.upsert(newCard({ workspaceId: "w1", cwd: "/p", title: "a" }));
  const b = await store.upsert({ ...newCard({ workspaceId: null, cwd: "/p", title: "b" }), agentId: "ag" });
  await store.upsert(newCard({ workspaceId: "w2", cwd: "/q", title: "c" }));
  const again = new BoardStore(join(dir, "board.json"));
  await again.load();
  assert.deepEqual(again.list("w1", "/p").map((card) => card.title), ["a", "b"]);
  assert.equal(again.byAgent("ag")?.id, b.id);
  await again.remove(a.id);
  assert.equal(JSON.parse(await readFile(join(dir, "board.json"), "utf8")).cards.length, 2);
});

test("a corrupt board file is ignored instead of crashing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-board-"));
  await writeFile(join(dir, "board.json"), "{not json");
  const store = new BoardStore(join(dir, "board.json"));
  await store.load();
  assert.deepEqual(store.all(), []);
});

test("the inbox yields valid messages in order and deletes the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todo-inbox-"));
  await writeFile(join(dir, "b.json"), JSON.stringify({ kind: "add", cwd: "/p", title: "새 일" }));
  await writeFile(join(dir, "a.json"), JSON.stringify({ kind: "report", cardId: "c1", stage: "plan", status: "done", summary: "ok" }));
  await writeFile(join(dir, "c.json"), "garbage");
  await writeFile(join(dir, "d.json"), JSON.stringify({ kind: "report", cardId: "c1" }));
  const entries = await readInbox(dir);
  assert.deepEqual(entries.map((entry) => entry.message.kind), ["report", "add"]);
  await consume(entries[0]);
  assert.deepEqual((await readInbox(dir)).map((entry) => entry.message.kind), ["add"]);
});
