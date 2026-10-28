import { type AgentStage, STAGE_LABELS } from "./board.ts";

export interface PromptCard {
  id: string;
  title: string;
  detail: string;
  baseRef: string | null;
}

export const planFile = (card: Pick<PromptCard, "id">) => `docs/plans/todo-${card.id.slice(0, 8)}.md`;

const HEADER = (card: PromptCard, stage: AgentStage) =>
  [
    `[투두 보드] 카드: ${card.title}`,
    card.detail ? `상세: ${card.detail}` : null,
    `현재 단계: ${STAGE_LABELS[stage]}`,
    "규칙: 이 단계의 작업이 끝나면 반드시 MCP 도구 `todo_report`를 호출한다(status는 done / fail / blocked, summary는 한국어로 핵심만).",
    "사용자에게 물어볼 것이 있거나 진행할 수 없으면 status=blocked로 보고하고 멈춘다. 보고 없이 턴을 끝내면 보드가 멈춘다.",
  ]
    .filter(Boolean)
    .join("\n");

const BODY: Record<AgentStage, (card: PromptCard, extra?: string) => string> = {
  plan: (card) =>
    [
      `코드베이스를 분석하고 \`${planFile(card)}\`에 구현 계획을 작성한다: 목표, 바꿀 파일, 단계, 검증 방법.`,
      "이 단계에서는 계획 파일 외의 파일을 만들거나 수정하지 않는다. summary에 계획 파일 경로와 핵심 요약을 넣는다.",
    ].join("\n"),
  implement: (card, extra) =>
    [
      `\`${planFile(card)}\`의 계획대로 구현한다. 관련 테스트를 실행해 통과를 확인한다. 커밋은 하지 않는다.`,
      extra ? `반려 사유(반드시 반영):\n${extra}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  review: (card) =>
    [
      card.baseRef ? `\`git diff ${card.baseRef}\`로 변경 내용을 읽는다.` : "작업 트리의 변경 파일 전체를 읽는다.",
      `\`${planFile(card)}\`의 계획과 비교해 누락, 버그, 보안 문제, 회귀 위험을 검토한다. 코드를 수정하지 않는다.`,
      "수정이 필요하면 status=fail에 수정 목록을, 문제가 없으면 status=done에 검토 요약을 보고한다.",
    ].join("\n"),
  qa: () =>
    [
      "이 프로젝트의 테스트, 린트, 타입체크를 실제로 실행하고 결과를 확인한다. 코드를 수정하지 않는다.",
      "하나라도 실패하면 status=fail에 실패 내역을, 모두 통과하면 status=done에 실행한 명령과 결과를 보고한다.",
    ].join("\n"),
};

export function stagePrompt(card: PromptCard, stage: AgentStage, extra?: string): string {
  return `${HEADER(card, stage)}\n\n${BODY[stage](card, extra)}`;
}
