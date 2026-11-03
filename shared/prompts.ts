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
    ...(options.planViaMessage
      ? [
          "규칙: 지금은 파일을 쓰거나 도구 승인을 받을 수 없는 plan 모드다. 계획 전문을 마지막 메시지로 출력하면 보드가 파일로 저장하고 다음 단계로 넘긴다.",
          `이 단계에서는 todo_report를 호출하지 않고 계획 승인(ExitPlanMode)도 요청하지 않는다. 진행할 수 없는 질문이 있으면 마지막 메시지의 첫 줄을 \`${BLOCKED_MARKER}\`로 시작하고 질문을 적는다.`,
        ]
      : [
          "규칙: 이 단계의 작업이 끝나면 반드시 MCP 도구 `todo_report`를 호출한다(status는 done / fail / blocked, summary는 한국어로 핵심만).",
          "사용자에게 물어볼 것이 있거나 진행할 수 없으면 status=blocked로 보고하고 멈춘다. 보고 없이 턴을 끝내면 보드가 멈춘다.",
        ]),
  ]
    .filter(Boolean)
    .join("\n");

const PLAN = (card: PromptCard, viaMessage: boolean) =>
  viaMessage
    ? "코드베이스를 분석하고 구현 계획을 세운다: 목표, 바꿀 파일, 단계, 검증 방법. 계획은 마크다운으로 마지막 메시지에 전부 적는다."
    : [
        `코드베이스를 분석하고 \`${card.planPath}\`(저장소 밖 파일)에 구현 계획을 작성한다: 목표, 바꿀 파일, 단계, 검증 방법.`,
        "이 단계에서는 저장소의 파일을 만들거나 수정하지 않는다. 계획 승인을 묻지 말고 todo_report로 보고한다.",
      ].join("\n");

const IMPLEMENT = (card: PromptCard, extra?: string) =>
  [
    card.type === "doc"
      ? "아래 계획대로 카드 상세의 산출물을 만든다. 코드를 바꾸지 않는다. 커밋은 하지 않는다. 산출물 외의 계획 파일이나 메모를 저장소 안에 만들지 않는다."
      : "아래 계획대로 구현한다. 관련 테스트를 실행해 통과를 확인한다. 커밋은 하지 않는다. 계획 파일이나 메모를 저장소 안에 만들지 않는다.",
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
