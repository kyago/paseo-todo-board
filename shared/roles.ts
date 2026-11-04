import type { AgentStage, CardType, Report } from "./board.ts";

export interface PromptCard {
  id: string;
  title: string;
  detail: string;
  baseRef: string | null;
  /** Absolute path of the plan file, outside the repository. */
  planPath: string;
  /** The plan text once it exists; embedded into later prompts so no session has to read outside its repository. */
  plan: string | null;
  type?: CardType;
  /** Earlier rejections and the fixes that answered them, for a team reviewing again. */
  priorRounds?: string | null;
  /** Repositories under a directory that is not one itself; the plan names the one to work in. */
  repos?: string[];
}

export const scope = (card: PromptCard) => (card.type === "doc" ? "범위: 카드 상세에 적힌 산출물" : card.baseRef ? `범위: \`git diff ${card.baseRef}\`와 \`git status\`의 새 파일` : "범위: 작업 트리의 변경 파일 전체");
const NO_EDIT = "코드를 수정하지 않는다.";
const VERDICT = `${NO_EDIT} 수용 기준이나 계획 위반, 사실 오류, 실제 결함이나 취약점만 status=fail에 수정 목록으로 보고하고, 그 밖의 개선 의견은 status=done의 summary에 제안으로 적는다.`;
/** The plan as a quoted section; prompts that compare work against the plan include it in full. */
export const planSection = (card: PromptCard) => (card.plan ? `계획:\n<plan>\n${card.plan.trim()}\n</plan>` : `계획 파일: ${card.planPath} (없으면 카드 상세를 계획으로 본다)`);

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
    prompt: (card) => ["목표: 결과물이 계획을 충족하고 기존 동작을 깨지 않는지 확인한다.", scope(card), planSection(card), VERDICT].join("\n"),
  },
  {
    id: "security",
    label: "보안",
    stage: "review",
    prompt: (card) => ["목표: 변경으로 생긴 취약점을 찾는다.", scope(card), VERDICT].join("\n"),
  },
  {
    id: "tests",
    label: "테스트 적정성",
    stage: "review",
    prompt: (card) =>
      ["목표: 변경된 동작이 테스트로 검증되는지 확인한다.", scope(card), `${NO_EDIT} 카드 상세가 테스트를 제외했으면 테스트가 없어도 fail이 아니다. 그렇지 않은데 변경된 동작에 테스트가 전혀 없으면 status=fail에 추가할 테스트 목록을 보고하고, 그 밖의 의견은 status=done의 summary에 제안으로 적는다.`].join("\n"),
  },
  {
    id: "qa-run",
    label: "테스트·린트·타입체크 실행",
    stage: "qa",
    prompt: () => ["목표: 테스트, 린트, 타입체크를 실행해 통과를 확인한다. 없는 검사는 건너뛴다.", `${NO_EDIT} 하나라도 실패하면 status=fail, 모두 통과하면 status=done.`].join("\n"),
  },
  {
    id: "qa-acceptance",
    label: "수용 기준 대조",
    stage: "qa",
    prompt: (card) => ["목표: 카드 상세의 수용 기준과 계획의 목표가 충족됐는지 항목별로 확인한다.", planSection(card), `${NO_EDIT} 하나라도 미충족이면 status=fail, 모두 충족이면 status=done.`].join("\n"),
  },
];

/** A card that changes no code has nothing for the security, test and simplicity roles or for running checks. */
const DOC_ROLES = new Set(["correctness", "qa-acceptance"]);

/** Enabled roles of a stage from a comma-separated setting; an empty or unknown selection means the whole team. */
export function rolesFor(stage: Role["stage"], enabled: string, type: CardType = "code"): Role[] {
  const ids = enabled.split(",").map((id) => id.trim()).filter(Boolean);
  const team = ROLES.filter((role) => role.stage === stage && (type === "code" || DOC_ROLES.has(role.id)));
  const chosen = team.filter((role) => ids.includes(role.id));
  return chosen.length > 0 ? chosen : team;
}

/**
 * A repeat review runs correctness plus the roles that failed last round. A full team finds something new every round,
 * which keeps cards looping and grows the work. The first round, and a team with nothing left, runs in full.
 */
export function recheckRoles(roles: Role[], reports: Report[]): Role[] {
  const implemented = reports.flatMap((report, index) => (report.stage === "implement" ? [index] : []));
  if (implemented.length < 2) return roles;
  const failed = reports.slice(implemented.at(-2)! + 1, implemented.at(-1)).filter((report) => report.stage === "review" && report.status === "fail").map((report) => report.role);
  const chosen = roles.filter((role) => role.id === "correctness" || failed.includes(role.label));
  return chosen.length > 0 ? chosen : roles;
}
