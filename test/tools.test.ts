import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { askTools, boardTools } from "../server/tools.ts";

const agent = { id: "agent-9", workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/proj", title: null };
const run = (tool: { input: { parse(v: unknown): unknown }; execute(input: unknown, context: any): unknown }, input: unknown) =>
  tool.execute(tool.input.parse(input), { agent, paseo: {}, signal: new AbortController().signal });

test("a board session gets todo_report, which drops a report stamped with the card, stage and calling agent", async () => {
  const inbox = await mkdtemp(join(tmpdir(), "inbox-"));
  const tools = boardTools(inbox, { "todo-board/card": "card-1", "todo-board/stage": "review" }, "/proj");
  assert.deepEqual(tools.map((tool) => tool.name), ["todo_report", "todo_add", "todo_start", "todo_complete"]);
  await run(tools[0], { status: "fail", summary: "테스트 누락" });
  await run(tools[1], { title: "후속 작업" });
  const messages = await Promise.all((await readdir(inbox)).map(async (name) => JSON.parse(await readFile(join(inbox, name), "utf8"))));
  assert.deepEqual(messages.find((m) => m.kind === "report"), { kind: "report", cardId: "card-1", agentId: "agent-9", stage: "review", status: "fail", summary: "테스트 누락" });
  assert.deepEqual(messages.find((m) => m.kind === "add"), { kind: "add", cwd: "/proj", title: "후속 작업" });
});

test("any other session only gets todo_add and todo_start", () => {
  assert.deepEqual(boardTools("/x", {}, "/proj").map((tool) => tool.name), ["todo_add", "todo_start", "todo_complete"]);
});

test("todo_add carries the card type and todo_complete drops a complete message for this directory", async () => {
  const inbox = await mkdtemp(join(tmpdir(), "inbox-"));
  const [add, , complete] = boardTools(inbox, {}, "/proj");
  await run(add, { title: "조사", type: "doc" });
  await run(complete, { query: "조사" });
  const messages = await Promise.all((await readdir(inbox)).map(async (name) => JSON.parse(await readFile(join(inbox, name), "utf8"))));
  assert.deepEqual(messages.find((m) => m.kind === "add"), { kind: "add", cwd: "/proj", title: "조사", type: "doc" });
  assert.deepEqual(messages.find((m) => m.kind === "complete"), { kind: "complete", cwd: "/proj", query: "조사" });
});

test("only team sessions get todo_agent_ask, which asks for this card and calling agent", async () => {
  const calls: unknown[][] = [];
  const ask = async (...args: unknown[]) => {
    calls.push(args);
    return { text: "답" };
  };
  assert.deepEqual(askTools({}, ask), []);
  assert.deepEqual(askTools({ "todo-board/card": "card-1" }, ask), []);
  const [tool] = askTools({ "todo-board/card": "card-1", "todo-board/stage": "review" }, ask);
  assert.equal(tool.name, "todo_agent_ask");
  assert.deepEqual(await run(tool, { question: " 왜? " }), { text: "답" });
  assert.deepEqual(calls, [["card-1", "agent-9", "왜?"]]);
});
