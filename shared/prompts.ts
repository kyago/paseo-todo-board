import { type AgentStage, STAGE_LABELS } from "./board.ts";
import { type PromptCard, type Role, planFile } from "./roles.ts";

export { type PromptCard, planFile } from "./roles.ts";

const HEADER = (card: PromptCard, stage: AgentStage, role?: Role) =>
  [
    `[투두 보드] 카드: ${card.title}`,
    card.detail ? `상세: ${card.detail}` : null,
    `현재 단계: ${STAGE_LABELS[stage]}${role ? ` · 역할: ${role.label}` : ""}`,
    "규칙: 이 단계의 작업이 끝나면 반드시 MCP 도구 `todo_report`를 호출한다(status는 done / fail / blocked, summary는 한국어로 핵심만).",
    "사용자에게 물어볼 것이 있거나 진행할 수 없으면 status=blocked로 보고하고 멈춘다. 보고 없이 턴을 끝내면 보드가 멈춘다.",
  ]
    .filter(Boolean)
    .join("\n");

const WORKER: Record<"plan" | "implement", (card: PromptCard, extra?: string) => string> = {
  plan: (card) =>
    [
      `코드베이스를 분석하고 \`${planFile(card)}\`에 구현 계획을 작성한다: 목표, 바꿀 파일, 단계, 검증 방법.`,
      "이 단계에서는 계획 파일 외의 파일을 만들거나 수정하지 않는다. 파일을 쓸 수 없는 모드라면 계획 전문을 summary에 넣는다(보드가 파일로 저장한다). 계획 승인을 묻지 말고 todo_report로 보고한다.",
    ].join("\n"),
  implement: (card, extra) =>
    [
      `\`${planFile(card)}\`의 계획대로 구현한다. 관련 테스트를 실행해 통과를 확인한다. 커밋은 하지 않는다.`,
      extra ? `반려 사유(반드시 반영):\n${extra}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
};

/** The prompt for a stage; review and QA prompts come from the team member's role. */
export function stagePrompt(card: PromptCard, stage: AgentStage, extra?: string, role?: Role): string {
  const body = stage === "plan" || stage === "implement" ? WORKER[stage](card, extra) : (role?.prompt(card) ?? "");
  return `${HEADER(card, stage, role)}\n\n${body}`;
}
