import type { Card, Stage } from "./board.ts";

const toMinutes = (ms: number) => Math.round(ms / 6000) / 10;
const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

export interface CardMetrics {
  retries: number;
  failsByRole: Record<string, number>;
  blocked: number;
  manual: number;
  /** First stage entry to completion; null while unfinished or on cards from before the timeline. */
  minutes: number | null;
  stageMinutes: Partial<Record<Stage, number>>;
}

/** The behaviour metrics of one card, from its reports and timeline. */
export function cardMetrics(card: Card): CardMetrics {
  const failsByRole: Record<string, number> = {};
  for (const report of card.reports) {
    if (report.status === "fail") failsByRole[report.role ?? report.stage] = (failsByRole[report.role ?? report.stage] ?? 0) + 1;
  }
  const entries = card.events.filter((event) => event.kind === "stage");
  const finished = entries.at(-1)?.stage === "done" && entries.length > 1;
  const spent: Partial<Record<Stage, number>> = {};
  for (const [index, entry] of entries.slice(0, -1).entries()) {
    spent[entry.stage] = (spent[entry.stage] ?? 0) + (Date.parse(entries[index + 1].at) - Date.parse(entry.at));
  }
  return {
    retries: card.retries,
    failsByRole,
    blocked: card.events.filter((event) => event.kind === "blocked").length,
    manual: card.events.filter((event) => event.kind === "action").length,
    minutes: finished ? toMinutes(Date.parse(entries.at(-1)!.at) - Date.parse(entries[0].at)) : null,
    stageMinutes: Object.fromEntries(Object.entries(spent).map(([stage, ms]) => [stage, toMinutes(ms)])),
  };
}

export interface VersionSummary {
  version: string;
  done: number;
  user: number | null;
  userCount: number;
  /** AI figures cover only cards the person also rated, so the summary cannot reveal a score before they rate. */
  ai: number | null;
  bothCount: number;
  gap: number | null;
  retries: number | null;
  blocked: number | null;
  manual: number | null;
  minutes: number | null;
}

/** Finished cards grouped by prompt version, newest version first, so a prompt change can be compared with the one before. */
export function summarize(cards: Card[]): VersionSummary[] {
  const groups = new Map<string, Card[]>();
  const done = cards.filter((card) => card.stage === "done").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const card of done) {
    const version = card.runMeta?.promptVersion ?? "기록 전";
    groups.set(version, [...(groups.get(version) ?? []), card]);
  }
  return [...groups].map(([version, group]) => {
    const metrics = group.map(cardMetrics);
    const both = group.flatMap((card) => (card.userRating && typeof card.aiRating?.score === "number" ? [{ user: card.userRating.score, ai: card.aiRating.score }] : []));
    const users = group.flatMap((card) => (card.userRating ? [card.userRating.score] : []));
    return {
      version,
      done: group.length,
      user: mean(users),
      userCount: users.length,
      ai: mean(both.map((pair) => pair.ai)),
      bothCount: both.length,
      gap: mean(both.map((pair) => Math.abs(pair.user - pair.ai))),
      retries: mean(metrics.map((item) => item.retries)),
      blocked: mean(metrics.map((item) => item.blocked)),
      manual: mean(metrics.map((item) => item.manual)),
      minutes: mean(metrics.flatMap((item) => (item.minutes === null ? [] : [item.minutes]))),
    };
  });
}
