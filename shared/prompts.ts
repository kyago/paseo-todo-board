import { type AgentStage, type Report, STAGE_LABELS } from "./board.ts";
import { type PromptCard, type Role, planSection, scope } from "./roles.ts";

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

/**
 * The prompt for the AI's own rating of a finished card. It stays independent: no team reports, prior rounds or user rating.
 * The rating is read from the last message, so a rating session needs no board tool.
 */
export function ratingPrompt(card: PromptCard): string {
  return [
    [`[투두 보드] 카드: ${card.title}`, card.detail ? `상세: ${card.detail}` : null, "현재 단계: 완료 결과 평가"].filter(Boolean).join("\n"),
    ["목표: 결과물이 카드의 의도를 얼마나 충족하는지 1~5점으로 평가한다. 5=그대로 쓴다, 3=쓸 수 있지만 아쉽다, 1=다시 해야 한다.", scope(card), planSection(card)].join("\n"),
    "규칙: 코드를 수정하지 않고 투두 도구를 쓰지 않는다. 마지막 메시지의 첫 줄에 `점수: N`을 쓰고 그 아래에 근거를 적는다.",
  ].join("\n\n");
}

const SCORE_LINE = /^[*_#> \t]*점수[*_ \t]*[:：][*_ \t]*([1-5])(?![\d.])/;

/** The score and reason in a rating session's last message; null when no line holds a valid score. */
export function parseRating(text: string): { score: number; reason: string } | null {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => SCORE_LINE.test(line));
  if (index < 0) return null;
  return { score: Number(lines[index].match(SCORE_LINE)![1]), reason: lines.filter((_, at) => at !== index).join("\n").replace(/^(?:\s*[-*_]{3,}\s*\n)+/, "").trim() };
}

/** The prompt for a stage; review and QA prompts come from the team member's role. */
export function stagePrompt(card: PromptCard, stage: AgentStage, options: PromptOptions = {}): string {
  const body =
    stage === "plan" ? PLAN(card, Boolean(options.planViaMessage)) : stage === "implement" ? IMPLEMENT(card, options.extra) : (options.role?.prompt(card) ?? "");
  return [HEADER(card, stage, options), body, options.role ? PRIOR(card) : null].filter(Boolean).join("\n\n");
}
