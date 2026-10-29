import { randomUUID } from "node:crypto";
import { type AgentStage, type Card, type ReportStatus, type Reviewer, type Stage, STAGES } from "../shared/board.ts";

/** What the runner must do after a transition. `send` goes to the worker session (created on first use); `create` starts the stage's team. */
export type Effect =
  | { kind: "none" }
  | { kind: "send"; stage: AgentStage; extra?: string }
  | { kind: "create"; stage: "review" | "qa" }
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
export const isTeamStage = (stage: Stage): stage is "review" | "qa" => stage === "review" || stage === "qa";

export const nextStage = (stage: Stage): Stage => STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 1)];

/** The sessions whose turns move the card: the worker on plan/implement, the team on review/qa. */
export const responsibleAgents = (card: Card): string[] =>
  isTeamStage(card.stage) ? card.reviewers.map((reviewer) => reviewer.agentId) : card.agentId && (card.stage === "plan" || card.stage === "implement") ? [card.agentId] : [];

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
    reviewers: [],
    baseRef: null,
    retries: 0,
    reports: [],
    createdAt: at,
    updatedAt: at,
  };
}

function entryEffect(stage: Stage, extra?: string): Effect {
  if (stage === "plan" || stage === "implement") return { kind: "send", stage, extra };
  if (isTeamStage(stage)) return { kind: "create", stage };
  if (stage === "done") return { kind: "finished" };
  return NONE;
}

/** Moves the card to the next stage and says what to run there. */
export function advance(card: Card, extra?: string): { card: Card; effect: Effect } {
  const stage = nextStage(card.stage);
  return {
    card: { ...card, stage, state: stage === "done" ? "idle" : "running", reviewers: [], attention: null, queued: false, updatedAt: now() },
    effect: entryEffect(stage, extra),
  };
}

/** The user's one move: todo → plan. */
export function start(card: Card): { card: Card; effect: Effect } {
  if (card.stage !== "todo") return { card, effect: NONE };
  return advance(card);
}

/** Runs the current stage again: the worker gets the stage prompt once more, review and QA get a fresh team. */
export function retryStage(card: Card): { card: Card; effect: Effect } {
  if (card.stage === "todo" || card.stage === "done") return { card, effect: NONE };
  const last = card.reports.at(-1);
  return {
    card: { ...card, state: "running", reviewers: [], attention: null, queued: false, updatedAt: now() },
    effect: entryEffect(card.stage, card.stage === "implement" && last?.status === "fail" ? last.summary : undefined),
  };
}

/** Review or QA sent the work back; the worker session gets the reason. */
export function rejectToImplement(card: Card, reason: string): { card: Card; effect: Effect } {
  return {
    card: { ...card, stage: "implement", state: "running", reviewers: [], attention: null, retries: card.retries + 1, updatedAt: now() },
    effect: { kind: "send", stage: "implement", extra: reason },
  };
}

function settle(card: Card, status: ReportStatus, failText: string, options: MachineOptions): { card: Card; effect: Effect } {
  if (card.paused || !options.autoAdvance) return { card: { ...card, state: "idle" }, effect: NONE };
  if (status === "fail") {
    if (card.retries + 1 > options.maxRetries) {
      return { card: { ...card, retries: card.retries + 1, state: "needs_human", attention: "재시도 상한 초과" }, effect: NONE };
    }
    return rejectToImplement(card, failText);
  }
  return advance(card);
}

/** Applies a `todo_report`. On team stages the card waits until every member has reported, then one fail means a rejection. */
export function applyReport(card: Card, report: IncomingReport, options: MachineOptions, agentId: string | null = null): { card: Card; effect: Effect } {
  if (card.stage === "todo" || card.stage === "done" || report.stage !== card.stage) return { card, effect: NONE };
  const at = now();
  if (!isTeamStage(card.stage)) {
    const recorded: Card = { ...card, reports: [...card.reports, { ...report, at }], attention: null, updatedAt: at };
    if (report.status === "blocked") return { card: { ...recorded, state: "blocked", attention: "질문 또는 중단" }, effect: NONE };
    if (report.status === "fail") return { card: { ...recorded, state: "blocked", attention: "실패 보고" }, effect: NONE };
    return settle(recorded, "done", "", options);
  }
  const member = card.reviewers.find((reviewer) => reviewer.agentId === agentId);
  if (!member) return { card, effect: NONE };
  const reviewers: Reviewer[] = card.reviewers.map((reviewer) => (reviewer.agentId === agentId ? { ...reviewer, status: report.status, summary: report.summary } : reviewer));
  const recorded: Card = { ...card, reviewers, reports: [...card.reports, { ...report, role: member.label, at }], attention: null, updatedAt: at };
  if (reviewers.some((reviewer) => reviewer.status === null)) return { card: recorded, effect: NONE };
  const blocked = reviewers.filter((reviewer) => reviewer.status === "blocked");
  if (blocked.length > 0) return { card: { ...recorded, state: "blocked", attention: `질문 또는 중단: ${blocked.map((r) => r.label).join(", ")}` }, effect: NONE };
  const fails = reviewers.filter((reviewer) => reviewer.status === "fail");
  const failText = fails.map((reviewer) => `[${reviewer.label}]\n${reviewer.summary ?? ""}`).join("\n\n");
  return settle(recorded, fails.length > 0 ? "fail" : "done", failText, options);
}

/** A responsible session ended its turn without a report; a missing team report blocks the whole stage. */
export function applyTurnEnded(card: Card, outcome: TurnOutcome, lastText: string | null, agentId: string | null = null): Card {
  if (card.state !== "running") return card;
  const member = isTeamStage(card.stage) ? card.reviewers.find((reviewer) => reviewer.agentId === agentId) : null;
  if (isTeamStage(card.stage) && (!member || member.status !== null)) return card;
  const why =
    outcome.kind === "failed"
      ? `오류: ${outcome.error.message}`
      : outcome.kind === "canceled"
        ? `취소됨: ${outcome.reason}`
        : `보고 없음${lastText ? `: ${lastText.slice(0, 200)}` : ""}`;
  const reviewers = member ? card.reviewers.map((reviewer) => (reviewer.agentId === agentId ? { ...reviewer, status: "blocked" as const, summary: why } : reviewer)) : card.reviewers;
  return { ...card, reviewers, state: "blocked", attention: member ? `${member.label}: ${why}` : why, updatedAt: now() };
}
