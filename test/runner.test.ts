import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, responsibleAgent } from "../server/runner.ts";
import { BoardStore } from "../server/store.ts";
import { boardSettings } from "../shared/settings.ts";

/** Enough of the Paseo SDK for the runner: creation returns ids, sends are recorded, timelines are empty. */
function fakePaseo() {
  const created: any[] = [];
  const sent: { agentId: string; text: string }[] = [];
  let counter = 0;
  const paseo = {
    agents: {
      create: async (options: any) => {
        created.push(options);
        return { id: `agent-${++counter}` };
      },
      ref: (agentId: string) => ({
        activeTurn: null,
        send: async (text: string) => void sent.push({ agentId, text }),
        refresh: async () => null,
        timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "마지막 답" } }] }) },
      }),
    },
    workspaces: { list: async () => ({ entries: [] }) },
  };
  return { paseo: paseo as any, created, sent };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "todo-runner-"));
  const store = new BoardStore(join(dir, "board.json"));
  await store.load();
  const inboxDir = join(dir, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const fake = fakePaseo();
  const runner = new Runner({
    store,
    inboxDir,
    settings: () => boardSettings.schema.parse({}),
    mcp: (env) => ({ type: "stdio", command: "node", args: ["mcp.mjs"], env, alwaysLoad: true }),
  });
  runner.attach(fake.paseo);
  const report = (cardId: string, status: string, summary: string, stage?: string) =>
    writeFile(join(inboxDir, `${Date.now()}-${Math.random()}.json`), JSON.stringify({ kind: "report", cardId, stage, status, summary }));
  return { store, runner, inboxDir, report, ...fake };
}

test("start creates the worker with the plan prompt and a card-bound MCP server; later stages reuse or create sessions", async () => {
  const { runner, store, created, sent, report } = await setup();
  const card = await runner.add({ workspaceId: "w", cwd: "/nonexistent-dir", title: "기능 A" });
  let current = (await runner.start(card.id))!;
  assert.equal(current.stage, "plan");
  assert.equal(current.agentId, "agent-1");
  assert.equal(current.baseRef, null);
  assert.equal(created[0].cwd, "/nonexistent-dir");
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_CARD_ID, card.id);
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_STAGE, undefined);
  assert.match(created[0].prompt, /현재 단계: 계획/);

  await report(card.id, "done", "계획 완료");
  await runner.onTurnEnded("agent-1", { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(sent.at(-1)?.agentId, "agent-1");
  assert.match(sent.at(-1)!.text, /현재 단계: 구현/);

  await report(card.id, "done", "구현 완료");
  await runner.onTurnEnded("agent-1", { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.equal(current.reviewerId, "agent-2");
  assert.equal(created[1].config.mcpServers["todo-board"].env.TODO_STAGE, "review");
  assert.equal(created[1].config.provider, "codex");

  await report(card.id, "fail", "테스트 누락", "review");
  await runner.onTurnEnded("agent-2", { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.retries, 1);
  assert.match(sent.at(-1)!.text, /테스트 누락/);
});

test("a turn from the session that is not responsible for the stage leaves the card alone", async () => {
  const { runner, store, report } = await setup();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "B" });
  await runner.start(card.id);
  await report(card.id, "done", "p");
  await runner.onTurnEnded("agent-1", { kind: "completed" });
  await report(card.id, "done", "i");
  await runner.onTurnEnded("agent-1", { kind: "completed" });
  const reviewing = store.get(card.id)!;
  assert.equal(reviewing.stage, "review");
  assert.equal(responsibleAgent(reviewing), "agent-2");
  await runner.onTurnEnded("agent-1", { kind: "completed" });
  assert.equal(store.get(card.id)!.state, "running");
  await runner.onTurnEnded("agent-2", { kind: "completed" });
  const blocked = store.get(card.id)!;
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.attention, "보고 없음: 마지막 답");
});

test("one card runs per directory; the next queued card starts when the first completes", async () => {
  const { runner, store } = await setup();
  const first = await runner.add({ workspaceId: "w", cwd: "/x", title: "1" });
  const second = await runner.add({ workspaceId: "w", cwd: "/x", title: "2" });
  await runner.start(first.id);
  const queued = (await runner.start(second.id))!;
  assert.equal(queued.stage, "todo");
  assert.equal(queued.queued, true);
  await runner.action(first.id, "complete");
  assert.equal(store.get(second.id)!.stage, "plan");
  assert.equal(store.get(second.id)!.queued, false);
});

test("todo_start from chat starts the matching todo card in that directory", async () => {
  const { runner, store, inboxDir } = await setup();
  const other = await runner.add({ workspaceId: "w", cwd: "/y", title: "로그인 수정" });
  const target = await runner.add({ workspaceId: "w", cwd: "/x", title: "로그인 수정" });
  await writeFile(join(inboxDir, "s.json"), JSON.stringify({ kind: "start", cwd: "/x", query: "로그인" }));
  await runner.processInbox();
  assert.equal(store.get(target.id)!.stage, "plan");
  assert.equal(store.get(other.id)!.stage, "todo");
  await writeFile(join(inboxDir, "t.json"), JSON.stringify({ kind: "start", cwd: "/x", query: "없는 카드" }));
  await runner.processInbox();
  assert.equal(store.all().filter((card) => card.stage === "plan").length, 1);
});

test("todo_add messages in the inbox become cards", async () => {
  const { runner, store, inboxDir } = await setup();
  await writeFile(join(inboxDir, "a.json"), JSON.stringify({ kind: "add", cwd: "/x", title: "세션에서 추가" }));
  await runner.processInbox();
  assert.equal(store.all()[0]?.title, "세션에서 추가");
  assert.equal(store.all()[0]?.workspaceId, null);
});
