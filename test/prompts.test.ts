import assert from "node:assert/strict";
import { test } from "node:test";
import { stagePrompt } from "../shared/prompts.ts";
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
  assert.match(ROLES.find((role) => role.id === "simplicity")!.prompt(card), /Lean already\. Ship\./);
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
  assert.doesNotMatch(text, /반드시 MCP 도구/);
  assert.match(stagePrompt(card, "plan"), /반드시 MCP 도구 `todo_report`/);
});
