import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, applyReport, applyTurnEnded, newCard, nextStage, rejectToImplement, responsibleAgents, retryStage, start } from "../server/machine.ts";
import type { Reviewer } from "../shared/board.ts";

const opts = { maxRetries: 2, autoAdvance: true };
const at = (stage: Parameters<typeof nextStage>[0], extra = {}) => ({ ...newCard({ workspaceId: "w", cwd: "/p", title: "t" }), stage, state: "running" as const, ...extra });
const team = (ids: string[]): Reviewer[] => ids.map((id) => ({ agentId: id, role: id, label: `역할 ${id}`, status: null, summary: null }));

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

test("worker reports walk plan → implement (same session) → review team", () => {
  let step = applyReport(at("plan"), { stage: "plan", status: "done", summary: "계획 작성" }, opts);
  assert.equal(step.card.stage, "implement");
  assert.equal(step.effect.kind, "send");
  step = applyReport(step.card, { stage: "implement", status: "done", summary: "구현" }, opts);
  assert.equal(step.card.stage, "review");
  assert.deepEqual(step.effect, { kind: "create", stage: "review" });
  assert.deepEqual(step.card.reviewers, []);
});

test("a team stage waits for every member, then all-done advances and any fail rejects with every reason", () => {
  const card = at("review", { reviewers: team(["a", "b", "c"]) });
  const first = applyReport(card, { stage: "review", status: "done", summary: "ok a" }, opts, "a");
  assert.equal(first.card.stage, "review");
  assert.equal(first.card.state, "running");
  assert.equal(first.effect.kind, "none");
  assert.equal(first.card.reviewers.find((r) => r.agentId === "a")?.status, "done");
  assert.equal(first.card.reports.at(-1)?.role, "역할 a");
  const second = applyReport(first.card, { stage: "review", status: "fail", summary: "테스트 누락" }, opts, "b");
  assert.equal(second.effect.kind, "none");
  const third = applyReport(second.card, { stage: "review", status: "fail", summary: "의존성 제거" }, opts, "c");
  assert.equal(third.card.stage, "implement");
  assert.equal(third.card.retries, 1);
  assert.deepEqual(third.card.reviewers, []);
  assert.equal(third.effect.kind, "send");
  assert.match((third.effect as { extra?: string }).extra ?? "", /\[역할 b\]\n테스트 누락[\s\S]*\[역할 c\]\n의존성 제거/);

  const qa = at("qa", { reviewers: team(["x", "y"]) });
  const done = applyReport(applyReport(qa, { stage: "qa", status: "done", summary: "" }, opts, "x").card, { stage: "qa", status: "done", summary: "" }, opts, "y");
  assert.equal(done.card.stage, "done");
  assert.equal(done.effect.kind, "finished");
});

test("a report from a session that is not on the team, or a stale stage, is ignored", () => {
  const card = at("review", { reviewers: team(["a"]) });
  assert.equal(applyReport(card, { stage: "review", status: "done", summary: "" }, opts, "stranger").effect.kind, "none");
  assert.equal(applyReport(card, { stage: "review", status: "done", summary: "" }, opts, "stranger").card.reports.length, 0);
  assert.equal(applyReport(at("review"), { stage: "plan", status: "done", summary: "late" }, opts).card.reports.length, 0);
  assert.equal(applyReport(at("done"), { stage: "done", status: "done", summary: "x" }, opts).effect.kind, "none");
});

test("retries past the limit stop for a person; blocked members block the stage", () => {
  const card = at("qa", { retries: 2, reviewers: team(["a"]) });
  const over = applyReport(card, { stage: "qa", status: "fail", summary: "또 실패" }, opts, "a");
  assert.equal(over.card.state, "needs_human");
  assert.equal(over.card.retries, 3);
  const blocked = applyReport(at("review", { reviewers: team(["a", "b"]) }), { stage: "review", status: "blocked", summary: "어느 DB?" }, opts, "a");
  assert.equal(blocked.card.state, "running");
  const settled = applyReport(blocked.card, { stage: "review", status: "done", summary: "" }, opts, "b");
  assert.equal(settled.card.state, "blocked");
  assert.match(settled.card.attention ?? "", /역할 a/);
});

test("a failed implementation and any blocked worker report stop the card for a person", () => {
  assert.equal(applyReport(at("implement"), { stage: "implement", status: "fail", summary: "못 함" }, opts).card.state, "blocked");
  const blocked = applyReport(at("plan"), { stage: "plan", status: "blocked", summary: "어느 DB?" }, opts);
  assert.equal(blocked.card.state, "blocked");
  assert.equal(blocked.card.reports.at(-1)?.summary, "어느 DB?");
});

test("paused cards and autoAdvance=false record the report without moving", () => {
  const paused = applyReport(at("plan", { paused: true }), { stage: "plan", status: "done", summary: "ok" }, opts);
  assert.equal(paused.card.stage, "plan");
  assert.equal(paused.card.state, "idle");
  const manual = applyReport(at("review", { reviewers: team(["a"]) }), { stage: "review", status: "done", summary: "ok" }, { ...opts, autoAdvance: false }, "a");
  assert.equal(manual.card.stage, "review");
  assert.equal(manual.effect.kind, "none");
});

test("a turn that ends without a report blocks the card; on a team only an unreported member counts", () => {
  assert.equal(applyTurnEnded(at("plan"), { kind: "completed" }, "마지막 말").attention, "보고 없음: 마지막 말");
  assert.equal(applyTurnEnded(at("plan"), { kind: "failed", error: { message: "boom" } }, null).attention, "오류: boom");
  const card = at("review", { reviewers: [{ ...team(["a"])[0], status: "done" }, ...team(["b"])] });
  assert.equal(applyTurnEnded(card, { kind: "completed" }, null, "a"), card);
  const blocked = applyTurnEnded(card, { kind: "canceled", reason: "user" }, null, "b");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reviewers.find((r) => r.agentId === "b")?.status, "blocked");
  assert.match(blocked.attention ?? "", /역할 b: 취소됨/);
  const idle = at("plan", { state: "idle" as const });
  assert.equal(applyTurnEnded(idle, { kind: "completed" }, null), idle);
});

test("manual advance, retry and reject reset the team and mirror the automatic moves", () => {
  assert.equal(advance(at("implement", { state: "blocked" as const })).card.stage, "review");
  const back = rejectToImplement(at("qa", { reviewers: team(["a"]) }), "사람이 반려");
  assert.equal(back.card.stage, "implement");
  assert.deepEqual(back.card.reviewers, []);
  assert.equal(back.card.retries, 1);
  const retry = retryStage(at("qa", { state: "needs_human" as const, reviewers: team(["a"]) }));
  assert.deepEqual(retry.effect, { kind: "create", stage: "qa" });
  assert.deepEqual(retry.card.reviewers, []);
  const failed = at("implement", { state: "blocked" as const, reports: [{ stage: "review" as const, status: "fail" as const, summary: "누락", at: "t" }] });
  assert.deepEqual(retryStage(failed).effect, { kind: "send", stage: "implement", extra: "누락" });
  assert.equal(retryStage(at("todo")).effect.kind, "none");
});

test("the responsible sessions are the worker on plan/implement and the whole team on review/qa", () => {
  assert.deepEqual(responsibleAgents(at("plan", { agentId: "w" })), ["w"]);
  assert.deepEqual(responsibleAgents(at("review", { agentId: "w", reviewers: team(["a", "b"]) })), ["a", "b"]);
  assert.deepEqual(responsibleAgents(at("done", { agentId: "w" })), []);
});
