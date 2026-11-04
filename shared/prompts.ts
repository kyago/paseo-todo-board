import { type AgentStage, type Report, STAGE_LABELS } from "./board.ts";
import { type PromptCard, type Role, planSection } from "./roles.ts";

export type { PromptCard } from "./roles.ts";

export interface PromptOptions {
  /** Rejection reasons for an implementation turn. */
  extra?: string;
  /** Team member on review and QA. */
  role?: Role;
  /** The planning turn runs in a read-only mode: the plan is the last message, no tool call, no plan approval. */
  planViaMessage?: boolean;
}

/** The first line of a message-mode plan that is a question instead of a plan. */
export const BLOCKED_MARKER = "BLOCKED:";

const HEADER = (card: PromptCard, stage: AgentStage, options: PromptOptions) =>
  [
    `[투두 보드] 카드: ${card.title}`,
    card.detail ? `상세: ${card.detail}` : null,
    `현재 단계: ${STAGE_LABELS[stage]}${options.role ? ` · 역할: ${options.role.label}` : ""}`,
    options.planViaMessage
      ? `규칙: 계획 전문을 마지막 메시지로 출력하면 보드가 저장한다. todo_report와 계획 승인(ExitPlanMode)은 쓰지 않는다. 진행할 수 없으면 첫 줄을 \`${BLOCKED_MARKER}\`로 시작하고 질문을 적는다.`
      : "규칙: 끝나면 `todo_report`로 보고한다(질문이 있거나 진행할 수 없으면 status=blocked).",
  ]
    .filter(Boolean)
    .join("\n");

const PLAN = (card: PromptCard, viaMessage: boolean) =>
  viaMessage ? "목표: 구현 계획을 세운다." : `목표: 구현 계획을 세워 \`${card.planPath}\`(저장소 밖 파일)에 쓴다. 저장소의 파일은 수정하지 않는다.`;

const IMPLEMENT = (card: PromptCard, extra?: string) =>
  [
    card.type === "doc" ? "목표: 계획대로 카드 상세의 산출물을 만든다. 코드는 바꾸지 않는다." : "목표: 계획대로 구현하고 동작을 확인한다.",
    "커밋은 보드가 하니 하지 않는다. 계획 파일이나 메모를 저장소 안에 만들지 않는다.",
    planSection(card),
    extra ? `반려 사유(반드시 반영):\n${extra}` : null,
  ]
    .filter(Boolean)
    .join("\n");

const PRIOR_SUMMARY_LIMIT = 800;

/** Rejections so far and the fixes that answered them; null until something was rejected. */
export function priorRounds(reports: Report[]): string | null {
  const first = reports.findIndex((report) => report.status === "fail");
  if (first < 0) return null;
  return reports
    .slice(first)
    .filter((report) => report.status === "fail" || report.stage === "implement")
    .map((report) => `- [${STAGE_LABELS[report.stage]}${report.role ? ` · ${report.role}` : ""}] ${report.status}: ${report.summary.slice(0, PRIOR_SUMMARY_LIMIT)}`)
    .join("\n");
}

const PRIOR = (card: PromptCard) =>
  card.priorRounds
    ? `이전 회차 기록이다. 여기서 정해진 것을 뒤집지 않고(지우라고 한 것을 다시 넣으라고 요구하는 등), 이미 지적되어 반영된 내용을 다시 지적하지 않는다.\n<prior>\n${card.priorRounds}\n</prior>`
    : null;

/** The prompt for a stage; review and QA prompts come from the team member's role. */
export function stagePrompt(card: PromptCard, stage: AgentStage, options: PromptOptions = {}): string {
  const body =
    stage === "plan" ? PLAN(card, Boolean(options.planViaMessage)) : stage === "implement" ? IMPLEMENT(card, options.extra) : (options.role?.prompt(card) ?? "");
  return [HEADER(card, stage, options), body, options.role ? PRIOR(card) : null].filter(Boolean).join("\n\n");
}
