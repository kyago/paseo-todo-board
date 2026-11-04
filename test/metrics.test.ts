import assert from "node:assert/strict";
import { test } from "node:test";
import { newCard } from "../server/machine.ts";
import type { Card } from "../shared/board.ts";
import { cardMetrics } from "../shared/metrics.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 0, minute)).toISOString();
const done = (extra: Partial<Card> = {}): Card => ({
  ...newCard({ workspaceId: "w", cwd: "/p", title: "t" }),
  stage: "done",
  events: [
    { kind: "stage", stage: "plan", at: at(0) },
    { kind: "stage", stage: "implement", at: at(2) },
    { kind: "stage", stage: "review", at: at(5) },
    { kind: "blocked", stage: "review", detail: "보고 없음", at: at(6) },
    { kind: "action", stage: "review", detail: "retry", at: at(7) },
    { kind: "stage", stage: "implement", at: at(8) },
    { kind: "stage", stage: "done", at: at(10) },
  ],
  ...extra,
});

test("a finished card's metrics count stops and interventions and add up revisited stages", () => {
  const reports = [
    { stage: "review" as const, status: "fail" as const, summary: "", at: at(7), role: "보안" },
    { stage: "review" as const, status: "fail" as const, summary: "", at: at(7), role: "보안" },
    { stage: "qa" as const, status: "done" as const, summary: "", at: at(9), role: "실행" },
  ];
  const metrics = cardMetrics(done({ retries: 1, reports }));
  assert.equal(metrics.retries, 1);
  assert.deepEqual(metrics.failsByRole, { 보안: 2 });
  assert.equal(metrics.blocked, 1);
  assert.equal(metrics.manual, 1);
  assert.equal(metrics.minutes, 10);
  assert.deepEqual(metrics.stageMinutes, { plan: 2, implement: 5, review: 3 });
});

test("a card without a timeline or still running has no duration", () => {
  assert.equal(cardMetrics(newCard({ workspaceId: "w", cwd: "/p", title: "t" })).minutes, null);
  assert.equal(cardMetrics(done({ events: [{ kind: "stage", stage: "plan", at: at(0) }] })).minutes, null);
});

test("a timeline that starts partway has no total, and the card says who finished it", () => {
  assert.equal(cardMetrics(done({ events: [{ kind: "stage", stage: "qa", at: at(0) }, { kind: "stage", stage: "done", at: at(5) }] })).minutes, null);
  assert.equal(cardMetrics(done()).completedBy, "qa");
  const manual = done({ events: [{ kind: "stage", stage: "plan", at: at(0) }, { kind: "action", stage: "plan", detail: "complete", at: at(1) }, { kind: "stage", stage: "done", at: at(1) }] });
  assert.equal(cardMetrics(manual).completedBy, "manual");
  assert.equal(cardMetrics(newCard({ workspaceId: "w", cwd: "/p", title: "t" })).completedBy, null);
});
