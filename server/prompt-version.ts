import { createHash } from "node:crypto";
import { AGENT_STAGES } from "../shared/board.ts";
import { ratingPrompt, stagePrompt } from "../shared/prompts.ts";
import { type PromptCard, ROLES } from "../shared/roles.ts";

const SAMPLE: PromptCard = { id: "sample", title: "제목", detail: "상세", baseRef: "base", planPath: "/plan.md", plan: "계획" };

/** A short hash of every prompt as rendered, so any wording change gets a new version without anyone bumping a number. */
export function promptVersion(): string {
  const samples = [SAMPLE, { ...SAMPLE, type: "doc" as const }];
  const rendered = samples.flatMap((card) => [
    ...AGENT_STAGES.map((stage) => stagePrompt(card, stage)),
    stagePrompt(card, "plan", { planViaMessage: true }),
    ...ROLES.map((role) => stagePrompt(card, role.stage, { role })),
    ratingPrompt(card),
  ]);
  return createHash("sha256").update(rendered.join("\n")).digest("hex").slice(0, 8);
}
