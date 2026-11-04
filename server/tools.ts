import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentToolDefinition, type AgentToolResult, defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { CardTypeSchema, type InboxMessage, ReportStatusSchema, StageSchema } from "../shared/board.ts";

export const CARD_LABEL = "todo-board/card";
export const STAGE_LABEL = "todo-board/stage";

/** Same inbox format the stdio MCP script writes, so reports still wait for their session's turn to end and survive a restart. */
export function drop(inbox: string, message: InboxMessage): void {
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, `${randomUUID()}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(message));
  renameSync(`${file}.tmp`, file);
}

/** Tools for one session: every session can add, start and complete cards; a session the board created (card label) also reports. */
export function boardTools(inbox: string, labels: Readonly<Record<string, string>>, cwd: string): AgentToolDefinition[] {
  const cardId = labels[CARD_LABEL];
  const stage = StageSchema.safeParse(labels[STAGE_LABEL]).data;
  const tools = [
    defineAgentTool({
      name: "todo_add",
      description: "투두 보드의 '할 일'에 카드를 추가한다. 사용자가 할 일로 남겨 두자고 할 때 쓴다.",
      input: z.object({
        title: z.string().min(1),
        detail: z.string().optional().describe("맥락, 수용 기준 등 (선택)"),
        type: CardTypeSchema.optional().describe("doc: 코드를 바꾸지 않는 조사·문서 카드. 산출물 경로를 detail에 적는다. 기본 code."),
      }),
      execute: ({ title, detail, type }) => {
        drop(inbox, { kind: "add", cwd, title: title.trim(), detail, type });
        return { text: `'할 일'에 추가했습니다: ${title}` };
      },
    }),
    defineAgentTool({
      name: "todo_start",
      description: "투두 보드의 '할 일' 카드를 '계획'으로 옮겨 자동 진행을 시작한다. 사용자가 그 카드를 시작하라고 할 때만 쓴다.",
      input: z.object({ query: z.string().min(1).describe("카드 제목의 일부 또는 카드 id 앞부분") }),
      execute: ({ query }) => {
        drop(inbox, { kind: "start", cwd, query: query.trim() });
        return { text: `시작을 요청했습니다: ${query}. 보드가 계획 세션을 만듭니다.` };
      },
    }),
    defineAgentTool({
      name: "todo_complete",
      description: "투두 보드에서 진행 중이거나 멈춘 카드를 '완료'로 옮긴다. 사용자가 그 카드를 완료하라고 할 때만 쓴다.",
      input: z.object({ query: z.string().min(1).describe("카드 제목의 일부 또는 카드 id 앞부분") }),
      execute: ({ query }) => {
        drop(inbox, { kind: "complete", cwd, query: query.trim() });
        return { text: `완료를 요청했습니다: ${query}.` };
      },
    }),
  ];
  if (!cardId) return tools;
  return [
    defineAgentTool({
      name: "todo_report",
      description: "투두 보드에 현재 단계의 결과를 보고한다. 단계 작업이 끝나면 반드시 한 번 호출한다. done=끝남, fail=검토/검증에서 수정 필요, blocked=질문이 있거나 진행 불가.",
      input: z.object({ status: ReportStatusSchema, summary: z.string().describe("한국어 요약. fail이면 수정 목록, blocked면 질문.") }),
      execute: ({ status, summary }, { agent }) => {
        drop(inbox, { kind: "report", cardId, agentId: agent.id, stage, status, summary });
        return { text: `보고했습니다 (${status}). 이제 턴을 마치세요.` };
      },
    }),
    ...tools,
  ];
}

export type AskWorker = (cardId: string, askerId: string, question: string) => Promise<AgentToolResult>;

/** Team sessions (card and stage labels) can question the card's worker; the answer comes back inside the same tool call, so their turn stays open. */
export function askTools(labels: Readonly<Record<string, string>>, ask: AskWorker): AgentToolDefinition[] {
  const cardId = labels[CARD_LABEL];
  if (!cardId || !StageSchema.safeParse(labels[STAGE_LABEL]).success) return [];
  return [
    defineAgentTool({
      name: "todo_agent_ask",
      description: "이 카드를 구현한 세션에 질문하고 답을 받는다. 구현 의도를 코드만으로 알 수 없을 때 판정 전에 쓴다.",
      input: z.object({ question: z.string().trim().min(1) }),
      execute: ({ question }, { agent }) => ask(cardId, agent.id, question),
    }),
  ];
}
