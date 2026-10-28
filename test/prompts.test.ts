import assert from "node:assert/strict";
import { test } from "node:test";
import { planFile, stagePrompt } from "../shared/prompts.ts";

const card = { id: "abcdef12-3456", title: "로그인 버그 수정", detail: "세션 만료 시 500", baseRef: "deadbeef" };

test("every stage prompt names the card, the stage and the report tool", () => {
  for (const stage of ["plan", "implement", "review", "qa"] as const) {
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
  assert.match(stagePrompt(card, "review"), /git diff deadbeef/);
  assert.match(stagePrompt({ ...card, baseRef: null }, "review"), /변경 파일 전체/);
});

test("a rejection reason is appended to the implementation prompt", () => {
  assert.match(stagePrompt(card, "implement", "테스트 누락"), /반려 사유[\s\S]*테스트 누락/);
  assert.doesNotMatch(stagePrompt(card, "implement"), /반려 사유/);
});
