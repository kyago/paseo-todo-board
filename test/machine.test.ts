import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, applyReport, applyTurnEnded, newCard, nextStage, rejectToImplement, retryStage, start } from "../server/machine.ts";

const opts = { maxRetries: 2, autoAdvance: true };
const at = (stage: Parameters<typeof nextStage>[0], extra = {}) => ({ ...newCard({ workspaceId: "w", cwd: "/p", title: "t" }), stage, state: "running" as const, ...extra });

test("stages advance in order and stop at done", () => {
  assert.equal(nextStage("todo"), "plan");
  assert.equal(nextStage("qa"), "done");
  assert.equal(nextStage("done"), "done");
});

test("start moves only todo cards into planning on the worker session", () => {
  const { card, effect } = start(newCard({ workspaceId: "w", cwd: "/p", title: " 제목 " }));
  assert.equal(card.title, "제목");
  assert.equal(card.stage, "plan");
  assert.equal(card.state, "running");
  assert.deepEqual(effect, { kind: "send", stage: "plan", extra: undefined });
  assert.equal(start(card).effect.kind, "none");
});

test("done reports walk plan → implement (same session) → review → qa (fresh sessions) → done", () => {
  let step = applyReport(at("plan"), { stage: "plan", status: "done", summary: "계획 작성" }, opts);
  assert.equal(step.card.stage, "implement");
  assert.equal(step.effect.kind, "send");
  step = applyReport(step.card, { stage: "implement", status: "done", summary: "구현" }, opts);
  assert.equal(step.card.stage, "review");
  assert.deepEqual(step.effect, { kind: "create", stage: "review" });
  step = applyReport({ ...step.card, reviewerId: "r1" }, { stage: "review", status: "done", summary: "이상 없음" }, opts);
  assert.equal(step.card.stage, "qa");
  assert.equal(step.card.reviewerId, null);
  assert.deepEqual(step.effect, { kind: "create", stage: "qa" });
  step = applyReport(step.card, { stage: "qa", status: "done", summary: "테스트 통과" }, opts);
  assert.equal(step.card.stage, "done");
  assert.equal(step.card.state, "idle");
  assert.equal(step.effect.kind, "finished");
  assert.equal(step.card.reports.length, 4);
});

test("a review or QA rejection goes back to implementation with the reason, up to maxRetries", () => {
  const first = applyReport(at("review"), { stage: "review", status: "fail", summary: "테스트 누락" }, opts);
  assert.equal(first.card.stage, "implement");
  assert.equal(first.card.retries, 1);
  assert.deepEqual(first.effect, { kind: "send", stage: "implement", extra: "테스트 누락" });
  const third = applyReport(at("qa", { retries: 2 }), { stage: "qa", status: "fail", summary: "또 실패" }, opts);
  assert.equal(third.card.stage, "qa");
  assert.equal(third.card.state, "needs_human");
  assert.equal(third.card.retries, 3);
  assert.equal(third.effect.kind, "none");
});

test("a failed implementation and any blocked report stop the card for a person", () => {
  const fail = applyReport(at("implement"), { stage: "implement", status: "fail", summary: "못 함" }, opts);
  assert.equal(fail.card.state, "blocked");
  assert.equal(fail.card.stage, "implement");
  const blocked = applyReport(at("plan"), { stage: "plan", status: "blocked", summary: "어느 DB?" }, opts);
  assert.equal(blocked.card.state, "blocked");
  assert.equal(blocked.card.reports.at(-1)?.summary, "어느 DB?");
  assert.equal(blocked.effect.kind, "none");
});

test("paused cards and autoAdvance=false record the report without moving", () => {
  const paused = applyReport(at("plan", { paused: true }), { stage: "plan", status: "done", summary: "ok" }, opts);
  assert.equal(paused.card.stage, "plan");
  assert.equal(paused.card.state, "idle");
  assert.equal(paused.card.reports.length, 1);
  const manual = applyReport(at("review"), { stage: "review", status: "done", summary: "ok" }, { ...opts, autoAdvance: false });
  assert.equal(manual.card.stage, "review");
  assert.equal(manual.effect.kind, "none");
});

test("reports for another stage, todo or done cards are ignored", () => {
  const stale = applyReport(at("review"), { stage: "plan", status: "done", summary: "late" }, opts);
  assert.equal(stale.card.reports.length, 0);
  assert.equal(stale.effect.kind, "none");
  assert.equal(applyReport(at("done"), { stage: "done", status: "done", summary: "x" }, opts).effect.kind, "none");
  assert.equal(applyReport(at("todo"), { stage: "todo", status: "done", summary: "x" }, opts).effect.kind, "none");
});

test("a turn that ends without a report blocks the card with the reason", () => {
  assert.equal(applyTurnEnded(at("plan"), { kind: "completed" }, "마지막 말").attention, "보고 없음: 마지막 말");
  assert.equal(applyTurnEnded(at("plan"), { kind: "failed", error: { message: "boom" } }, null).attention, "오류: boom");
  assert.equal(applyTurnEnded(at("plan"), { kind: "canceled", reason: "user" }, null).state, "blocked");
  const idle = at("plan", { state: "idle" as const });
  assert.equal(applyTurnEnded(idle, { kind: "completed" }, null), idle);
});

test("manual advance and reject mirror the automatic moves", () => {
  assert.equal(advance(at("implement", { state: "blocked" as const })).card.stage, "review");
  const back = rejectToImplement(at("qa"), "사람이 반려");
  assert.equal(back.card.stage, "implement");
  assert.equal(back.card.retries, 1);
});

test("retry runs the current stage again and carries the last rejection into implementation", () => {
  const blocked = retryStage(at("plan", { state: "blocked" as const, attention: "보고 없음" }));
  assert.equal(blocked.card.state, "running");
  assert.equal(blocked.card.attention, null);
  assert.deepEqual(blocked.effect, { kind: "send", stage: "plan", extra: undefined });
  const failed = at("implement", { state: "blocked" as const, reports: [{ stage: "review" as const, status: "fail" as const, summary: "누락", at: "t" }] });
  assert.deepEqual(retryStage(failed).effect, { kind: "send", stage: "implement", extra: "누락" });
  assert.deepEqual(retryStage(at("qa", { state: "needs_human" as const })).effect, { kind: "create", stage: "qa" });
  assert.equal(retryStage(at("todo")).effect.kind, "none");
});
