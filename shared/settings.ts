import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const boardSettings = defineSettings({
  id: "board",
  scope: "host",
  version: 1,
  schema: z.object({
    // How many times a review or QA rejection sends the card back to implementation before a person must look.
    // Give every new session the `todo_add` / `todo_report` tools. Board-created sessions always get them.
    injectTools: z.boolean().default(true),
    maxRetries: z.number().int().min(0).max(5).default(2),
    // Off: reports are recorded but no stage transition happens without a button press.
    autoAdvance: z.boolean().default(true),
    // `provider` or `provider/model` for the session that plans and implements.
    workerProvider: z.string().min(1).default("claude"),
    // `provider` or `provider/model` for the fresh sessions that review and verify.
    reviewerProvider: z.string().min(1).default("codex"),
    // Permission mode id given to every session the board creates (claude: auto, acceptEdits, bypassPermissions; codex: auto, full-access).
    workerMode: z.string().default("auto"),
    // Mode for the planning turn only; empty means workerMode. Claude's `plan` mode cannot write the plan file, so the board writes it from the report.
    planMode: z.string().default(""),
    reviewerMode: z.string().default("full-access"),
    // Comma-separated role ids from shared/roles.ts; an empty or unknown list means every role of that stage.
    reviewRoles: z.string().default("correctness,security,tests,simplicity"),
    qaRoles: z.string().default("qa-run,qa-acceptance"),
  }),
});

export type BoardSettingsValues = z.infer<typeof boardSettings.schema>;
