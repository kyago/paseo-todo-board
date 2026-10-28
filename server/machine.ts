import { randomUUID } from "node:crypto";
import { type AgentStage, type Card, type ReportStatus, type Stage, STAGES } from "../shared/board.ts";

/** What the runner must do after a transition. `send` goes to the worker session (created on first use); `create` starts a fresh reviewer. */
export type Effect =
  | { kind: "none" }
  | { kind: "send"; stage: AgentStage; extra?: string }
  | { kind: "create"; stage: AgentStage }
  | { kind: "finished" };

export interface MachineOptions {
  maxRetries: number;
  autoAdvance: boolean;
}

export interface IncomingReport {
  stage: Stage;
  status: ReportStatus;
  summary: string;
}

export type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };

const NONE: Effect = { kind: "none" };
const now = () => new Date().toISOString();

export const nextStage = (stage: Stage): Stage => STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 1)];

export function newCard(input: { workspaceId: string | null; cwd: string; title: string; detail?: string }): Card {
  const at = now();
  return {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    title: input.title.trim(),
    detail: input.detail?.trim() ?? "",
    stage: "todo",
    state: "idle",
    paused: false,
    queued: false,
    attention: null,
    agentId: null,
    reviewerId: null,
    baseRef: null,
    retries: 0,
    reports: [],
    createdAt: at,
    updatedAt: at,
  };
}

function entryEffect(stage: Stage, extra?: string): Effect {
  if (stage === "plan" || stage === "implement") return { kind: "send", stage, extra };
  if (stage === "review" || stage === "qa") return { kind: "create", stage };
  if (stage === "done") return { kind: "finished" };
  return NONE;
}

/** Moves the card to the next stage and says what to run there. */
export function advance(card: Card, extra?: string): { card: Card; effect: Effect } {
  const stage = nextStage(card.stage);
  return {
    card: { ...card, stage, state: stage === "done" ? "idle" : "running", reviewerId: null, attention: null, queued: false, updatedAt: now() },
    effect: entryEffect(stage, extra),
  };
}

/** The user's one move: todo → plan. */
export function start(card: Card): { card: Card; effect: Effect } {
  if (card.stage !== "todo") return { card, effect: NONE };
  return advance(card);
}

/** Review or QA sent the work back; the worker session gets the reason. */
export function rejectToImplement(card: Card, reason: string): { card: Card; effect: Effect } {
  return {
    card: { ...card, stage: "implement", state: "running", reviewerId: null, attention: null, retries: card.retries + 1, updatedAt: now() },
    effect: { kind: "send", stage: "implement", extra: reason },
  };
}

/** Applies a `todo_report` for the card's current stage. Stale or foreign reports change nothing. */
export function applyReport(card: Card, report: IncomingReport, options: MachineOptions): { card: Card; effect: Effect } {
  if (card.stage === "todo" || card.stage === "done" || report.stage !== card.stage) return { card, effect: NONE };
  const at = now();
  const recorded: Card = { ...card, reports: [...card.reports, { ...report, at }], attention: null, updatedAt: at };
  if (report.status === "blocked") return { card: { ...recorded, state: "blocked", attention: "질문 또는 중단" }, effect: NONE };
  if (card.paused || !options.autoAdvance) return { card: { ...recorded, state: "idle" }, effect: NONE };
  if (report.status === "fail") {
    if (card.stage !== "review" && card.stage !== "qa") return { card: { ...recorded, state: "blocked", attention: "실패 보고" }, effect: NONE };
    if (card.retries + 1 > options.maxRetries) {
      return { card: { ...recorded, retries: card.retries + 1, state: "needs_human", attention: "재시도 상한 초과" }, effect: NONE };
    }
    return rejectToImplement(recorded, report.summary);
  }
  return advance(recorded);
}

/** The agent's turn ended without a report for this card. */
export function applyTurnEnded(card: Card, outcome: TurnOutcome, lastText: string | null): Card {
  if (card.state !== "running") return card;
  const attention =
    outcome.kind === "failed"
      ? `오류: ${outcome.error.message}`
      : outcome.kind === "canceled"
        ? `취소됨: ${outcome.reason}`
        : `보고 없음${lastText ? `: ${lastText.slice(0, 200)}` : ""}`;
  return { ...card, state: "blocked", attention, updatedAt: now() };
}
