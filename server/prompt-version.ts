import { createHash } from "node:crypto";
import { AGENT_STAGES } from "../shared/board.ts";
import { ratingPrompt, stagePrompt } from "../shared/prompts.ts";
import { type PromptCard, ROLES } from "../shared/roles.ts";

const SAMPLE: PromptCard = { id: "sample", title: "제목", detail: "상세", baseRef: "base", planPath: "/plan.md", plan: "계획", priorRounds: "이전 회차" };
const SAMPLES: PromptCard[] = [SAMPLE, { ...SAMPLE, type: "doc" }, { ...SAMPLE, baseRef: null, plan: null, priorRounds: null }];
const hash = (texts: string[]) => createHash("sha256").update(texts.join("\n")).digest("hex").slice(0, 8);

/** A short hash of every work prompt as rendered in each branch, so a wording change gets a new version without anyone bumping a number. */
export const promptVersion = (): string =>
  hash(
    SAMPLES.flatMap((card) => [
      ...AGENT_STAGES.map((stage) => stagePrompt(card, stage)),
      stagePrompt(card, "implement", { extra: "반려 사유" }),
      stagePrompt(card, "plan", { planViaMessage: true }),
      ...ROLES.map((role) => stagePrompt(card, role.stage, { role })),
    ]),
  );

export const ratingVersion = (): string => hash(SAMPLES.map(ratingPrompt));
