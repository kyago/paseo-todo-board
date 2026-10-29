import type { AgentStage } from "./board.ts";

export interface PromptCard {
  id: string;
  title: string;
  detail: string;
  baseRef: string | null;
}

export const planFile = (card: Pick<PromptCard, "id">) => `docs/plans/todo-${card.id.slice(0, 8)}.md`;

const diffLine = (card: PromptCard) => (card.baseRef ? `\`git diff ${card.baseRef}\`로 변경 내용을 읽는다.` : "작업 트리의 변경 파일 전체를 읽는다.");
const NO_EDIT = "코드를 수정하지 않는다. 다른 관점은 다른 팀원이 보니 이 역할의 범위만 본다.";
const VERDICT = "수정이 필요하면 status=fail에 수정 목록을, 문제가 없으면 status=done에 확인한 내용을 보고한다.";

export interface Role {
  id: string;
  label: string;
  stage: Extract<AgentStage, "review" | "qa">;
  prompt: (card: PromptCard) => string;
}

/** The review and QA teams. Each member gets its own session and reports on its own; the board aggregates. */
export const ROLES: Role[] = [
  {
    id: "correctness",
    label: "정확성·회귀",
    stage: "review",
    prompt: (card) => [diffLine(card), `\`${planFile(card)}\`의 계획과 비교해 누락, 논리 오류, 경계 조건, 기존 동작의 회귀를 검토한다. ${NO_EDIT}`, VERDICT].join("\n"),
  },
  {
    id: "security",
    label: "보안",
    stage: "review",
    prompt: (card) =>
      [
        diffLine(card),
        `신뢰 경계의 입력 검증, 비밀값·토큰 노출, 권한·인증 우회, 주입(SQL·명령·경로), 안전하지 않은 기본값, 로그에 남는 민감 정보만 본다. ${NO_EDIT}`,
        VERDICT,
      ].join("\n"),
  },
  {
    id: "tests",
    label: "테스트 적정성",
    stage: "review",
    prompt: (card) =>
      [
        diffLine(card),
        `변경된 동작마다 그 동작을 깨뜨리면 실패하는 테스트가 있는지, 테스트가 구현 세부가 아니라 동작을 검증하는지, 시간·순서·네트워크에 기대는 깨지기 쉬운 테스트가 없는지 본다. ${NO_EDIT}`,
        "덮이지 않은 동작이 있으면 status=fail에 추가할 테스트 목록을, 충분하면 status=done을 보고한다.",
      ].join("\n"),
  },
  {
    id: "simplicity",
    label: "오버엔지니어링",
    stage: "review",
    prompt: (card) =>
      [
        diffLine(card),
        "불필요한 복잡도만 찾는다. 결과는 한 줄에 하나, `파일:L줄: 태그 무엇. 대체안.` 형식으로 쓴다.",
        "태그: delete(죽은 코드, 쓰지 않는 유연성, 추측성 기능 → 대체 없음) / stdlib(표준 라이브러리에 있는 것을 직접 구현 → 함수 이름) / native(플랫폼이 이미 하는 일을 하는 의존성·코드 → 기능 이름) / yagni(구현이 하나뿐인 추상화, 아무도 쓰지 않는 설정, 호출자가 하나인 계층 → 인라인) / shrink(같은 논리를 더 짧게 → 짧은 형태 제시).",
        "정확성·보안·성능은 범위 밖이다. 스모크 테스트 하나나 assert 자가검사는 삭제 대상이 아니다. 마지막 줄에 `net: -N lines possible`을 쓴다.",
        `${NO_EDIT}`,
        "의존성 제거나 추상화 제거가 있거나 net이 -10줄 이상이면 status=fail에 목록을, 그 미만이면 status=done에 제안만 적는다. 줄일 게 없으면 `Lean already. Ship.`으로 status=done.",
      ].join("\n"),
  },
  {
    id: "qa-run",
    label: "테스트·린트·타입체크 실행",
    stage: "qa",
    prompt: () =>
      [
        "이 프로젝트의 테스트, 린트, 타입체크를 실제로 실행하고 결과를 확인한다. 스크립트가 없는 검사는 없다고 적는다. 코드를 수정하지 않는다.",
        "하나라도 실패하면 status=fail에 실패 내역을, 모두 통과하면 status=done에 실행한 명령과 결과 요약(통과/실패 수)을 보고한다.",
      ].join("\n"),
  },
  {
    id: "qa-acceptance",
    label: "수용 기준 대조",
    stage: "qa",
    prompt: (card) =>
      [
        `카드 상세의 수용 기준과 \`${planFile(card)}\`의 목표를 항목별로 나열하고, 코드를 읽고 가능하면 직접 실행해 각 항목의 충족 여부를 확인한다.`,
        "변경된 동작을 덮는 테스트가 없으면 미충족으로 본다. 코드를 수정하지 않는다.",
        "항목별 ✔/✘ 표를 보고에 넣고, ✘가 하나라도 있으면 status=fail, 모두 ✔이면 status=done.",
      ].join("\n"),
  },
];

/** Enabled roles of a stage from a comma-separated setting; an empty or unknown selection means the whole team. */
export function rolesFor(stage: Role["stage"], enabled: string): Role[] {
  const ids = enabled.split(",").map((id) => id.trim()).filter(Boolean);
  const team = ROLES.filter((role) => role.stage === stage);
  const chosen = team.filter((role) => ids.includes(role.id));
  return chosen.length > 0 ? chosen : team;
}
