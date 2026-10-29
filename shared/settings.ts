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
    // Mode for the planning turn only; empty means workerMode. With `plan` the session cannot write or call tools, so the plan is the turn's last message and the board saves it as the plan file.
    planMode: z.string().default("plan"),
    // Each card works on its own branch in a Paseo worktree (`todo/<id>`); off means in place, one card at a time per directory.
    useWorktree: z.boolean().default(true),
    // After QA passes: commit, push the branch and open a draft pull request with the plan and the reports.
    createPr: z.boolean().default(true),
    // After completion: archive the card's sessions, and its worktree workspace once the PR exists.
    autoArchive: z.boolean().default(true),
    reviewerMode: z.string().default("full-access"),
    // Comma-separated role ids from shared/roles.ts; an empty or unknown list means every role of that stage.
    reviewRoles: z.string().default("correctness,security,tests,simplicity"),
    qaRoles: z.string().default("qa-run,qa-acceptance"),
  }),
});

export type BoardSettingsValues = z.infer<typeof boardSettings.schema>;
