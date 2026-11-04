import assert from "node:assert/strict";
import { test } from "node:test";
import { priorRounds, stagePrompt } from "../shared/prompts.ts";
import { ROLES, rolesFor } from "../shared/roles.ts";

const card = { id: "abcdef12-3456", title: "로그인 버그 수정", detail: "세션 만료 시 500", baseRef: "deadbeef", planPath: "/data/plans/todo-abcdef12.md", plan: "1. 토큰 갱신\n2. 테스트" };

test("every stage prompt names the card, the stage and the report tool", () => {
  for (const stage of ["plan", "implement"] as const) {
    const text = stagePrompt(card, stage);
    assert.match(text, /로그인 버그 수정/);
    assert.match(text, /todo_report/);
    assert.match(text, /세션 만료 시 500/);
  }
  assert.match(stagePrompt(card, "plan"), /현재 단계: 계획/);
  assert.match(stagePrompt(card, "qa"), /현재 단계: 품질 검증/);
});

test("the plan text is embedded into later prompts and never asked to be written into the repository", () => {
  assert.match(stagePrompt(card, "implement"), /<plan>\n1\. 토큰 갱신\n2\. 테스트\n<\/plan>/);
  assert.match(stagePrompt(card, "implement"), /저장소 안에 만들지 않는다/);
  assert.match(stagePrompt({ ...card, plan: null }, "implement"), /계획 파일: \/data\/plans\/todo-abcdef12\.md/);
  assert.match(stagePrompt(card, "plan"), /\/data\/plans\/todo-abcdef12\.md.*저장소 밖/);
});

test("review diffs against the base ref when there is one, else reads the whole tree", () => {
  const correctness = ROLES.find((role) => role.id === "correctness")!;
  assert.match(stagePrompt(card, "review", { role: correctness }), /git diff deadbeef/);
  assert.match(stagePrompt({ ...card, baseRef: null }, "review", { role: correctness }), /변경 파일 전체/);
  assert.match(stagePrompt(card, "review", { role: correctness }), /역할: 정확성·회귀[\s\S]*todo_report/);
});

test("roles are selected by id per stage and fall back to the whole team", () => {
  assert.deepEqual(rolesFor("review", "simplicity, security").map((role) => role.id), ["security", "simplicity"]);
  assert.deepEqual(rolesFor("review", "").map((role) => role.id), ["correctness", "security", "tests", "simplicity"]);
  assert.deepEqual(rolesFor("qa", "nope").map((role) => role.id), ["qa-run", "qa-acceptance"]);
  for (const role of ROLES) assert.match(role.prompt(card), /status=fail|status=done/);
});

test("a rejection reason is appended to the implementation prompt", () => {
  assert.match(stagePrompt(card, "implement", { extra: "테스트 누락" }), /반려 사유[\s\S]*테스트 누락/);
  assert.doesNotMatch(stagePrompt(card, "implement"), /반려 사유/);
});

test("a message-mode plan prompt asks for the plan as the last message and forbids tools and plan approval", () => {
  const text = stagePrompt(card, "plan", { planViaMessage: true });
  assert.match(text, /마지막 메시지/);
  assert.match(text, /ExitPlanMode/);
  assert.match(text, /BLOCKED:/);
  assert.doesNotMatch(text, /끝나면 `todo_report`로 보고/);
  assert.match(stagePrompt(card, "plan"), /끝나면 `todo_report`로 보고/);
});

test("rejection is limited to real problems, and the simplicity role never rejects", () => {
  const roles = Object.fromEntries(ROLES.map((role) => [role.id, role.prompt(card)]));
  assert.match(roles.correctness, /수용 기준이나 계획 위반, 사실 오류, 실제 결함이나 취약점만 status=fail/);
  assert.match(roles.correctness, /개선 의견은 status=done의 summary에 제안/);
  assert.match(roles.tests, /테스트가 전혀 없으면 status=fail/);
  assert.doesNotMatch(roles.simplicity, /status=fail/);
  assert.match(roles.simplicity, /반려하지 않는다/);
});

test("every prompt states a goal", () => {
  for (const stage of ["plan", "implement"] as const) assert.match(stagePrompt(card, stage), /목표: /);
  for (const role of ROLES) assert.match(role.prompt(card), /^목표: /);
});

test("a doc card runs only the roles that can judge it and its prompts point at the deliverable", () => {
  const doc = { ...card, type: "doc" as const };
  assert.deepEqual(rolesFor("review", "", "doc").map((role) => role.id), ["correctness"]);
  assert.deepEqual(rolesFor("qa", "", "doc").map((role) => role.id), ["qa-acceptance"]);
  assert.deepEqual(rolesFor("review", "security", "doc").map((role) => role.id), ["correctness"]);
  const correctness = ROLES.find((role) => role.id === "correctness")!;
  assert.match(correctness.prompt(doc), /카드 상세에 적힌 산출물/);
  assert.doesNotMatch(correctness.prompt(doc), /git diff/);
  assert.match(stagePrompt(doc, "implement"), /산출물을 만든다/);
  assert.doesNotMatch(stagePrompt(doc, "implement"), /구현하고/);
});

test("prior rounds keep rejections and the fixes that answered them, and only team prompts show them", () => {
  const at = "2026-11-03T00:00:00Z";
  const reports = [
    { stage: "plan" as const, status: "done" as const, summary: "계획 본문", at },
    { stage: "implement" as const, status: "done" as const, summary: "처음 구현", at },
    { stage: "review" as const, status: "done" as const, summary: "문제 없음", at, role: "보안" },
    { stage: "review" as const, status: "fail" as const, summary: "체크리스트를 지운다", at, role: "오버엔지니어링" },
    { stage: "implement" as const, status: "done" as const, summary: "체크리스트 삭제", at },
  ];
  assert.equal(priorRounds(reports.slice(0, 3)), null);
  const text = priorRounds(reports)!;
  assert.match(text, /\[검토 · 오버엔지니어링\] fail: 체크리스트를 지운다/);
  assert.match(text, /\[구현\] done: 체크리스트 삭제/);
  assert.doesNotMatch(text, /계획 본문|처음 구현|문제 없음/);
  assert.equal(priorRounds([{ stage: "review", status: "fail", summary: "가".repeat(2000), at }])!.length < 900, true);

  const correctness = ROLES.find((role) => role.id === "correctness")!;
  const again = { ...card, priorRounds: text };
  assert.match(stagePrompt(again, "review", { role: correctness }), /뒤집지 않고[\s\S]*<prior>[\s\S]*체크리스트 삭제/);
  assert.doesNotMatch(stagePrompt(again, "implement"), /<prior>/);
  assert.doesNotMatch(stagePrompt(card, "review", { role: correctness }), /<prior>/);
});
