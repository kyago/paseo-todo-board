import assert from "node:assert/strict";
import { test } from "node:test";
import { planFile, stagePrompt } from "../shared/prompts.ts";
import { ROLES, rolesFor } from "../shared/roles.ts";

const card = { id: "abcdef12-3456", title: "로그인 버그 수정", detail: "세션 만료 시 500", baseRef: "deadbeef" };

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

test("the plan file is derived from the card id and reused by later stages", () => {
  assert.equal(planFile(card), "docs/plans/todo-abcdef12.md");
  assert.match(stagePrompt(card, "implement"), /docs\/plans\/todo-abcdef12\.md/);
});

test("review diffs against the base ref when there is one, else reads the whole tree", () => {
  const correctness = ROLES.find((role) => role.id === "correctness")!;
  assert.match(stagePrompt(card, "review", undefined, correctness), /git diff deadbeef/);
  assert.match(stagePrompt({ ...card, baseRef: null }, "review", undefined, correctness), /변경 파일 전체/);
  assert.match(stagePrompt(card, "review", undefined, correctness), /역할: 정확성·회귀[\s\S]*todo_report/);
});

test("roles are selected by id per stage and fall back to the whole team", () => {
  assert.deepEqual(rolesFor("review", "simplicity, security").map((role) => role.id), ["security", "simplicity"]);
  assert.deepEqual(rolesFor("review", "").map((role) => role.id), ["correctness", "security", "tests", "simplicity"]);
  assert.deepEqual(rolesFor("qa", "nope").map((role) => role.id), ["qa-run", "qa-acceptance"]);
  for (const role of ROLES) assert.match(role.prompt(card), /status=fail|status=done/);
  assert.match(ROLES.find((role) => role.id === "simplicity")!.prompt(card), /Lean already\. Ship\./);
});

test("a rejection reason is appended to the implementation prompt", () => {
  assert.match(stagePrompt(card, "implement", "테스트 누락"), /반려 사유[\s\S]*테스트 누락/);
  assert.doesNotMatch(stagePrompt(card, "implement"), /반려 사유/);
});
