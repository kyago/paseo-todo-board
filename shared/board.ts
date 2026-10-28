import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const STAGES = ["todo", "plan", "implement", "review", "qa", "done"] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;
/** Stages an agent works on, in order. */
export const AGENT_STAGES = ["plan", "implement", "review", "qa"] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  todo: "할 일",
  plan: "계획",
  implement: "구현",
  review: "검토",
  qa: "품질 검증",
  done: "완료",
};

export const ReportStatusSchema = z.enum(["done", "fail", "blocked"]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const ReportSchema = z.object({
  stage: StageSchema,
  status: ReportStatusSchema,
  summary: z.string(),
  at: z.string(),
});
export type Report = z.infer<typeof ReportSchema>;

export const CardStateSchema = z.enum(["idle", "running", "blocked", "needs_human"]);
export type CardState = z.infer<typeof CardStateSchema>;

export const CardSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  title: z.string(),
  detail: z.string().default(""),
  stage: StageSchema,
  state: CardStateSchema,
  /** The user stopped automatic transitions; reports are still recorded. */
  paused: z.boolean().default(false),
  /** Waiting for another card in the same workspace to finish. */
  queued: z.boolean().default(false),
  /** Why the card needs a look: "permission", "보고 없음", an error message, or null. */
  attention: z.string().nullable().default(null),
  /** Session that plans and implements. */
  agentId: z.string().nullable().default(null),
  /** Session that reviews or verifies the current stage. */
  reviewerId: z.string().nullable().default(null),
  /** `git rev-parse HEAD` when work started; null outside a git repository. */
  baseRef: z.string().nullable().default(null),
  retries: z.number().int().default(0),
  reports: z.array(ReportSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Card = z.infer<typeof CardSchema>;

/** Messages the MCP server drops into the inbox directory. */
export const InboxMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("report"),
    cardId: z.string(),
    /** Set for reviewer sessions (one per stage); the worker session's report applies to the card's current stage. */
    stage: StageSchema.optional(),
    status: ReportStatusSchema,
    summary: z.string(),
  }),
  z.object({ kind: z.literal("add"), cwd: z.string(), title: z.string().min(1), detail: z.string().optional() }),
]);
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const CARD_ACTIONS = ["start", "advance", "reject", "complete", "delete", "pause", "resume"] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

export const listCards = defineRpc({
  name: "board.list",
  input: z.object({ workspaceId: z.string(), cwd: z.string() }),
  output: z.object({ cards: z.array(CardSchema) }),
});

export const addCard = defineRpc({
  name: "board.add",
  input: z.object({ workspaceId: z.string(), cwd: z.string(), title: z.string().min(1), detail: z.string().optional() }),
  output: z.object({ card: CardSchema }),
});

export const cardAction = defineRpc({
  name: "board.action",
  input: z.object({ cardId: z.string(), action: z.enum(CARD_ACTIONS) }),
  output: z.object({ card: CardSchema.nullable() }),
});
