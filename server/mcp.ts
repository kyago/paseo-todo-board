import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The stdio MCP server every agent gets. It has no dependencies: newline-delimited JSON-RPC in,
 * one JSON file per call out, into the inbox the plugin server watches.
 */
export const MCP_SCRIPT = String.raw`import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const inbox = process.env.TODO_INBOX;
const cardId = process.env.TODO_CARD_ID || null;
const stage = process.env.TODO_STAGE || null;
const agentId = process.env.TODO_AGENT_ID || null;
const cwd = process.env.TODO_CWD || process.cwd();

const tools = [
  {
    name: "todo_report",
    description: "투두 보드에 현재 단계의 결과를 보고한다. 단계 작업이 끝나면 반드시 한 번 호출한다. done=끝남, fail=검토/검증에서 수정 필요, blocked=질문이 있거나 진행 불가.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "fail", "blocked"] },
        summary: { type: "string", description: "한국어 요약. fail이면 수정 목록, blocked면 질문." },
      },
      required: ["status", "summary"],
    },
  },
  {
    name: "todo_add",
    description: "투두 보드의 '할 일'에 카드를 추가한다. 사용자가 할 일로 남겨 두자고 할 때 쓴다.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, detail: { type: "string", description: "맥락, 수용 기준 등 (선택)" } },
      required: ["title"],
    },
  },
  {
    name: "todo_start",
    description: "투두 보드의 '할 일' 카드를 '계획'으로 옮겨 자동 진행을 시작한다. 사용자가 그 카드를 시작하라고 할 때만 쓴다.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "카드 제목의 일부 또는 카드 id 앞부분" } },
      required: ["query"],
    },
  },
];

function drop(message) {
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, randomUUID() + ".json");
  writeFileSync(file + ".tmp", JSON.stringify(message));
  renameSync(file + ".tmp", file);
}

function call(name, args) {
  if (!inbox) return { text: "TODO_INBOX가 없어 보고할 수 없습니다.", isError: true };
  if (name === "todo_report") {
    if (!cardId) return { text: "이 세션은 보드 카드에 연결되어 있지 않습니다. 보고는 보드가 만든 세션에서만 가능합니다.", isError: true };
    drop({ kind: "report", cardId, agentId: agentId ?? undefined, stage: stage ?? undefined, status: args.status, summary: String(args.summary ?? "") });
    return { text: "보고했습니다 (" + args.status + "). 이제 턴을 마치세요." };
  }
  if (name === "todo_add") {
    drop({ kind: "add", cwd, title: String(args.title ?? "").trim(), detail: args.detail ? String(args.detail) : undefined });
    return { text: "'할 일'에 추가했습니다: " + args.title };
  }
  if (name === "todo_start") {
    drop({ kind: "start", cwd, query: String(args.query ?? "").trim() });
    return { text: "시작을 요청했습니다: " + args.query + ". 보드가 계획 세션을 만듭니다." };
  }
  return { text: "알 수 없는 도구: " + name, isError: true };
}

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");

function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return write({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "todo-board", version: "1" } } });
  }
  if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "tools/call") {
    const { text, isError } = call(params?.name, params?.arguments ?? {});
    return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: Boolean(isError) } });
  }
  if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

export async function installMcpScript(file: string): Promise<string> {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, MCP_SCRIPT);
  return file;
}

/** The daemon subprocess may run inside Electron, so prefer a real `node` for the agents' MCP process. */
export async function resolveNode(): Promise<string> {
  const candidates = [
    process.env.TODO_BOARD_NODE,
    basename(process.execPath).startsWith("node") ? process.execPath : undefined,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return "node";
}

export interface StdioMcpServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  alwaysLoad: boolean;
}

export function mcpServerConfig(node: string, script: string, env: Record<string, string>): StdioMcpServer {
  return { type: "stdio", command: node, args: [script], env, alwaysLoad: true };
}
