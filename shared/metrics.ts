import type { Card, Stage } from "./board.ts";

const toMinutes = (ms: number) => Math.round(ms / 6000) / 10;

export interface CardMetrics {
  retries: number;
  failsByRole: Record<string, number>;
  blocked: number;
  manual: number;
  /** First stage entry to completion; null while unfinished or on cards whose timeline starts partway. */
  minutes: number | null;
  /** Who finished the card: QA passing it, or a person's button or command. Null on cards from before the timeline. */
  completedBy: "qa" | "manual" | null;
  stageMinutes: Partial<Record<Stage, number>>;
}

/** The behaviour metrics of one card, from its reports and timeline. */
export function cardMetrics(card: Card): CardMetrics {
  const failsByRole: Record<string, number> = {};
  for (const report of card.reports) {
    if (report.status === "fail") failsByRole[report.role ?? report.stage] = (failsByRole[report.role ?? report.stage] ?? 0) + 1;
  }
  const entries = card.events.filter((event) => event.kind === "stage");
  const finished = entries.at(-1)?.stage === "done" && entries[0].stage === "plan";
  const beforeDone = card.events.at(card.events.lastIndexOf(entries.at(-1)!) - 1);
  const closedByHand = beforeDone?.kind === "action" && (beforeDone.detail === "complete" || beforeDone.detail === "advance");
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
    completedBy: entries.at(-1)?.stage === "done" ? (closedByHand ? "manual" : "qa") : null,
    stageMinutes: Object.fromEntries(Object.entries(spent).map(([stage, ms]) => [stage, toMinutes(ms)])),
  };
}
