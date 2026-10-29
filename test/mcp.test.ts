import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installMcpScript, mcpServerConfig } from "../server/mcp.ts";

async function talk(env: Record<string, string>, requests: object[]): Promise<any[]> {
  const dir = await mkdtemp(join(tmpdir(), "todo-mcp-"));
  const script = await installMcpScript(join(dir, "mcp.mjs"));
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const lines: string[] = [];
  const done = new Promise<void>((resolve) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) lines.push(line);
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      if (lines.length >= requests.length) resolve();
    });
  });
  for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  await done;
  child.kill();
  return lines.map((line) => JSON.parse(line));
}

test("the MCP server answers initialize and lists both tools", async () => {
  const [init, list] = await talk({ TODO_INBOX: await mkdtemp(join(tmpdir(), "inbox-")) }, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(list.result.tools.map((tool: any) => tool.name), ["todo_report", "todo_add", "todo_start"]);
});

test("todo_report drops a report for the session's card and todo_add drops a new card", async () => {
  const inbox = await mkdtemp(join(tmpdir(), "inbox-"));
  const [report, add] = await talk({ TODO_INBOX: inbox, TODO_CARD_ID: "card-1", TODO_AGENT_ID: "agent-9", TODO_STAGE: "review", TODO_CWD: "/proj" }, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "todo_report", arguments: { status: "fail", summary: "테스트 누락" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "todo_add", arguments: { title: "후속 작업" } } },
  ]);
  assert.equal(report.result.isError, false);
  assert.equal(add.result.isError, false);
  const files = (await readdir(inbox)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 2);
  const messages = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(inbox, name), "utf8"))));
  assert.deepEqual(messages.find((m) => m.kind === "report"), { kind: "report", cardId: "card-1", agentId: "agent-9", stage: "review", status: "fail", summary: "테스트 누락" });
  assert.deepEqual(messages.find((m) => m.kind === "add"), { kind: "add", cwd: "/proj", title: "후속 작업" });
});

test("a session without a card cannot report", async () => {
  const [reply] = await talk({ TODO_INBOX: await mkdtemp(join(tmpdir(), "inbox-")) }, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "todo_report", arguments: { status: "done", summary: "x" } } },
  ]);
  assert.equal(reply.result.isError, true);
});

test("the server config points node at the installed script with the env", () => {
  assert.deepEqual(mcpServerConfig("/usr/bin/node", "/x/mcp.mjs", { TODO_INBOX: "/x/inbox" }), {
    type: "stdio",
    command: "/usr/bin/node",
    args: ["/x/mcp.mjs"],
    env: { TODO_INBOX: "/x/inbox" },
    alwaysLoad: true,
  });
});
