import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, isBoardToolRequest } from "../server/runner.ts";
import { BoardStore } from "../server/store.ts";
import { boardSettings } from "../shared/settings.ts";

/** Enough of the Paseo SDK for the runner: creation honours the requested id, sends are recorded, timelines are empty. */
function fakePaseo() {
  const created: any[] = [];
  const sent: { agentId: string; text: string; options: any }[] = [];
  const paseo = {
    agents: {
      create: async (options: any) => {
        created.push(options);
        return { id: options.agentId };
      },
      ref: (agentId: string) => ({
        activeTurn: null,
        send: async (text: string, options: any) => void sent.push({ agentId, text, options }),
        refresh: async () => null,
        timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "마지막 답" } }] }) },
      }),
    },
    workspaces: { list: async () => ({ entries: [] }) },
    providers: { listModels: async (provider: string) => ({ models: [{ id: "m-old" }, { id: `${provider}-default`, isDefault: true }] }) },
  };
  return { paseo: paseo as any, created, sent };
}

async function setup(overrides: Partial<ReturnType<typeof boardSettings.schema.parse>> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "todo-runner-"));
  const store = new BoardStore(join(dir, "board.json"));
  await store.load();
  const inboxDir = join(dir, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const fake = fakePaseo();
  const runner = new Runner({
    store,
    inboxDir,
    settings: () => ({ ...boardSettings.schema.parse({}), ...overrides }),
    mcp: (env) => ({ type: "stdio", command: "node", args: ["mcp.mjs"], env, alwaysLoad: true }),
  });
  const report = (cardId: string, agentId: string, status: string, summary: string, stage?: string) =>
    writeFile(join(inboxDir, `${Date.now()}-${Math.random()}.json`), JSON.stringify({ kind: "report", cardId, agentId, stage, status, summary }));
  return { dir, store, runner, inboxDir, report, attach: () => runner.attach(fake.paseo), ...fake };
}

test("start creates the worker with a chosen id and a card-bound MCP server; the plan turn may use its own mode", async () => {
  const { runner, store, created, sent, report, attach, dir } = await setup({ planMode: "plan" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: dir, title: "기능 A" });
  let current = (await runner.start(card.id))!;
  assert.equal(current.stage, "plan");
  assert.equal(current.agentId, created[0].agentId);
  assert.equal(created[0].config.modeId, "plan");
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_AGENT_ID, created[0].agentId);
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_STAGE, undefined);
  assert.equal(created[0].config.provider, "claude/claude-default");
  assert.match(created[0].prompt, /현재 단계: 계획/);

  await report(card.id, current.agentId!, "done", "1. 파일 수정\n2. 테스트");
  await runner.onTurnEnded(current.agentId!, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(sent.at(-1)?.agentId, current.agentId);
  assert.equal(sent.at(-1)?.options.sessionMode, "auto");
  assert.match(sent.at(-1)!.text, /현재 단계: 구현/);
  // Plan mode cannot write files, so the report became the plan file.
  assert.match(await readFile(join(dir, "docs/plans", `todo-${card.id.slice(0, 8)}.md`), "utf8"), /기능 A[\s\S]*1\. 파일 수정/);
});

test("review fans out one session per enabled role; the card moves once every member has reported", async () => {
  const { runner, store, created, sent, report, attach } = await setup({ reviewRoles: "security,simplicity", qaRoles: "qa-run" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "B" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  await report(card.id, worker, "done", "p");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await report(card.id, worker, "done", "i");
  await runner.onTurnEnded(worker, { kind: "completed" });
  let current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.deepEqual(current.reviewers.map((r) => r.role), ["security", "simplicity"]);
  assert.equal(created.length, 3);
  assert.equal(created[1].config.provider, "codex/codex-default");
  assert.equal(created[1].config.modeId, "full-access");
  assert.match(created[1].title, /검토 · 보안/);
  assert.match(created[2].prompt, /net: -N lines possible/);
  const [security, simplicity] = current.reviewers.map((r) => r.agentId);

  // Both report into the same inbox; each turn end only consumes its own report.
  await report(card.id, security, "done", "안전", "review");
  await report(card.id, simplicity, "fail", "L3: yagni: 추상화", "review");
  await runner.onTurnEnded(security, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.equal(current.reviewers.find((r) => r.agentId === security)?.status, "done");
  assert.equal(current.reviewers.find((r) => r.agentId === simplicity)?.status, null);
  await runner.onTurnEnded(simplicity, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.retries, 1);
  assert.match(sent.at(-1)!.text, /\[오버엔지니어링\]\nL3: yagni/);

  // A turn from a session that is not responsible for the stage leaves the card alone.
  await runner.onTurnEnded(security, { kind: "completed" });
  assert.equal(store.get(card.id)!.stage, "implement");
});

test("a team member that ends without reporting blocks the stage with its role named", async () => {
  const { runner, store, report, attach } = await setup({ reviewRoles: "tests" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "C" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  for (const stage of ["plan", "implement"]) {
    await report(card.id, worker, "done", stage);
    await runner.onTurnEnded(worker, { kind: "completed" });
  }
  const reviewer = store.get(card.id)!.reviewers[0].agentId;
  await runner.onTurnEnded(reviewer, { kind: "completed" });
  const blocked = store.get(card.id)!;
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.attention, "테스트 적정성: 보고 없음: 마지막 답");
});

test("one card runs per directory; the next queued card starts when the first completes", async () => {
  const { runner, store, attach } = await setup();
  attach();
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
  const { runner, store, inboxDir, attach } = await setup();
  attach();
  const other = await runner.add({ workspaceId: "w", cwd: "/y", title: "로그인 수정" });
  const target = await runner.add({ workspaceId: "w", cwd: "/x", title: "로그인 수정" });
  await writeFile(join(inboxDir, "s.json"), JSON.stringify({ kind: "start", cwd: "/x", query: "로그인" }));
  await runner.processInbox();
  assert.equal(store.get(target.id)!.stage, "plan");
  assert.equal(store.get(other.id)!.stage, "todo");
});

test("a start before any daemon session queues the card; the first session starts it", async () => {
  const { runner, store, attach, created } = await setup();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "early" });
  const queued = (await runner.start(card.id))!;
  assert.equal(queued.queued, true);
  attach();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.get(card.id)!.stage, "plan");
  assert.equal(created.length, 1);
});

test("todo_add messages in the inbox become cards", async () => {
  const { runner, store, inboxDir } = await setup();
  await writeFile(join(inboxDir, "a.json"), JSON.stringify({ kind: "add", cwd: "/x", title: "세션에서 추가" }));
  await runner.processInbox();
  assert.equal(store.all()[0]?.title, "세션에서 추가");
});

test("only the board's own MCP tool prompts are recognised", () => {
  assert.equal(isBoardToolRequest({ name: "CodexMcpElicitation", title: "MCP approval: todo-board", metadata: { serverName: "todo-board" } }), true);
  assert.equal(isBoardToolRequest({ name: "mcp__todo-board__todo_report" }), true);
  assert.equal(isBoardToolRequest({ name: "Bash", title: "rm -rf /" }), false);
});
