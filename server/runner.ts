import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type Card, type CardAction, type InboxMessage, STAGE_LABELS } from "../shared/board.ts";
import { planFile, stagePrompt } from "../shared/prompts.ts";
import { rolesFor } from "../shared/roles.ts";
import type { BoardSettingsValues } from "../shared/settings.ts";
import { consume, readInbox } from "./inbox.ts";
import { type Effect, type TurnOutcome, advance, applyReport, applyTurnEnded, newCard, rejectToImplement, responsibleAgents, retryStage, start } from "./machine.ts";
import type { StdioMcpServer } from "./mcp.ts";
import type { BoardStore } from "./store.ts";

type Paseo = PluginHandlerContext["paseo"];
const run = promisify(execFile);

export interface RunnerDeps {
  store: BoardStore;
  inboxDir: string;
  settings: () => BoardSettingsValues;
  /** Builds the MCP server entry for a session the board creates. */
  mcp: (env: Record<string, string>) => StdioMcpServer;
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    return (await run("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Permission prompts for the board's own MCP tools (Codex asks per MCP server; Claude names them mcp__<server>__<tool>). */
export const isBoardToolRequest = (request: { name: string; title?: string; metadata?: Record<string, unknown> }): boolean =>
  request.metadata?.serverName === "todo-board" || request.name.startsWith("mcp__todo-board__") || /todo-board/i.test(request.title ?? "");

export class Runner {
  private paseo: Paseo | null = null;
  private reconciled = false;
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /** Handlers and hooks hand over the daemon session; the first one also recovers cards left running by a restart. */
  attach(paseo: Paseo): void {
    this.paseo = paseo;
    if (this.reconciled) return;
    this.reconciled = true;
    void this.reconcile().catch((error) => console.error("[todo-board] reconcile failed", error));
  }

  private api(): Paseo {
    if (!this.paseo) throw new Error("Paseo 세션이 아직 없습니다. 잠시 후 다시 시도하세요.");
    return this.paseo;
  }

  private get store() {
    return this.deps.store;
  }

  private activeIn(cwd: string, except?: string): boolean {
    return this.store.all().some((card) => card.cwd === cwd && card.id !== except && card.state === "running");
  }

  async add(input: { workspaceId: string | null; cwd: string; title: string; detail?: string }): Promise<Card> {
    return this.store.upsert(newCard(input));
  }

  /** The user's move: todo → plan. One card runs per directory; the rest queue, as does a start before any daemon session exists. */
  async start(cardId: string): Promise<Card | null> {
    const card = this.store.get(cardId);
    if (!card || card.stage !== "todo") return card ?? null;
    if (this.activeIn(card.cwd, card.id) || !this.paseo) return this.store.upsert({ ...card, queued: true, updatedAt: new Date().toISOString() });
    const baseRef = await gitHead(card.cwd);
    const step = start({ ...card, baseRef, queued: false });
    return this.commit(step.card, step.effect);
  }

  async action(cardId: string, action: CardAction): Promise<Card | null> {
    const card = this.store.get(cardId);
    if (!card) return null;
    const at = new Date().toISOString();
    switch (action) {
      case "start":
        return this.start(cardId);
      case "advance": {
        if (card.stage === "todo") return this.start(cardId);
        const step = advance(card);
        return this.commit(step.card, step.effect);
      }
      case "retry": {
        const step = retryStage(card);
        return this.commit(step.card, step.effect);
      }
      case "reject": {
        if (card.stage !== "review" && card.stage !== "qa") return card;
        const step = rejectToImplement(card, "사용자가 반려했습니다. 마지막 검토 보고를 다시 읽고 보완하세요.");
        return this.commit(step.card, step.effect);
      }
      case "complete": {
        const done = await this.store.upsert({ ...card, stage: "done", state: "idle", reviewers: [], queued: false, attention: null, updatedAt: at });
        await this.releaseQueue(card.cwd);
        return done;
      }
      case "delete":
        await this.store.remove(cardId);
        await this.releaseQueue(card.cwd);
        return null;
      case "pause":
        return this.store.upsert({ ...card, paused: true, updatedAt: at });
      case "resume":
        return this.store.upsert({ ...card, paused: false, updatedAt: at });
    }
  }

  /** A responsible session ended a turn: apply its report, or block the card when there is none. */
  async onTurnEnded(agentId: string, outcome: TurnOutcome): Promise<void> {
    const card = this.store.byAgent(agentId);
    if (!card || !responsibleAgents(card).includes(agentId) || card.state !== "running") {
      await this.processInbox();
      return;
    }
    const entries = await readInbox(this.deps.inboxDir);
    let latest: Extract<InboxMessage, { kind: "report" }> | null = null;
    for (const entry of entries) {
      const { message } = entry;
      if (message.kind === "report") {
        if (message.cardId !== card.id) continue;
        // Team members report in parallel; only this session's report is consumed here.
        if (card.reviewers.length > 0 && message.agentId && message.agentId !== agentId) continue;
        latest = message;
        await consume(entry);
      } else {
        await consume(entry);
        if (message.kind === "add") await this.handleAdd(message);
        else await this.handleStart(message);
      }
    }
    if (latest) {
      if (card.stage === "plan" && latest.status === "done") await this.ensurePlanFile(card, latest.summary);
      const step = applyReport(card, { stage: latest.stage ?? card.stage, status: latest.status, summary: latest.summary }, this.deps.settings(), agentId);
      await this.commit(step.card, step.effect);
      return;
    }
    await this.store.upsert(applyTurnEnded(card, outcome, await this.lastText(agentId), agentId));
  }

  async onPermission(agentId: string, pending: boolean): Promise<void> {
    const card = this.store.byAgent(agentId);
    if (!card || !responsibleAgents(card).includes(agentId)) return;
    const attention = pending ? "권한 요청 대기" : card.attention === "권한 요청 대기" ? null : card.attention;
    if (attention !== card.attention) await this.store.upsert({ ...card, attention, updatedAt: new Date().toISOString() });
  }

  /** `todo_add` and `todo_start` take effect at once; reports wait for their session's turn to end. */
  async processInbox(): Promise<void> {
    for (const entry of await readInbox(this.deps.inboxDir)) {
      if (entry.message.kind === "report") continue;
      await consume(entry);
      if (entry.message.kind === "add") await this.handleAdd(entry.message);
      else await this.handleStart(entry.message);
    }
  }

  private async handleStart(message: Extract<InboxMessage, { kind: "start" }>): Promise<void> {
    const query = message.query.toLowerCase();
    const card = this.store
      .all()
      .filter((card) => card.cwd === message.cwd && card.stage === "todo")
      .find((card) => card.id.startsWith(query) || card.title.toLowerCase().includes(query));
    if (card) await this.start(card.id);
    else console.error(`[todo-board] start: no todo card matching "${message.query}" in ${message.cwd}`);
  }

  private async handleAdd(message: Extract<InboxMessage, { kind: "add" }>): Promise<void> {
    await this.add({ workspaceId: await this.workspaceFor(message.cwd), cwd: message.cwd, title: message.title, detail: message.detail });
  }

  private async workspaceFor(cwd: string): Promise<string | null> {
    if (!this.paseo) return null;
    try {
      const { entries } = await this.paseo.workspaces.list();
      return entries.find((workspace) => (workspace.workspaceDirectory ?? workspace.projectRootPath) === cwd)?.id ?? null;
    } catch {
      return null;
    }
  }

  /** A planning turn in Claude's plan mode cannot write files, so the plan text in the report becomes the plan file. */
  private async ensurePlanFile(card: Card, summary: string): Promise<void> {
    const file = join(card.cwd, planFile(card));
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `# ${card.title}\n\n${summary}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") console.error("[todo-board] plan file", error);
    }
  }

  /** The SDK wants `provider/model`; a bare provider name takes that provider's default model. */
  private async resolveProvider(value: string): Promise<string> {
    const trimmed = value.trim();
    if (trimmed.includes("/")) return trimmed;
    const result = (await this.api().providers.listModels(trimmed)) as { models?: { id: string; isDefault?: boolean }[] };
    const models = result.models ?? [];
    const model = models.find((item) => item.isDefault) ?? models[0];
    if (!model) throw new Error(`${trimmed}: 모델 목록이 비어 있습니다. 설정에 provider/model 형식으로 적어 주세요.`);
    return `${trimmed}/${model.id}`;
  }

  private async commit(card: Card, effect: Effect): Promise<Card> {
    const saved = await this.store.upsert(card);
    try {
      const after = await this.execute(saved, effect);
      return this.store.upsert(after);
    } catch (error) {
      console.error(`[todo-board] stage ${card.stage} for ${card.id} failed`, error);
      return this.store.upsert({ ...saved, state: "blocked", attention: `실행 실패: ${(error as Error).message}`, updatedAt: new Date().toISOString() });
    }
  }

  private async execute(card: Card, effect: Effect): Promise<Card> {
    const settings = this.deps.settings();
    switch (effect.kind) {
      case "send": {
        const prompt = stagePrompt(card, effect.stage, effect.extra);
        const mode = (effect.stage === "plan" ? settings.planMode || settings.workerMode : settings.workerMode) || undefined;
        if (card.agentId) {
          await this.api().agents.ref(card.agentId).send(prompt, { sessionMode: mode });
          return card;
        }
        // The session id is chosen up front so the MCP server can stamp reports with it.
        const agentId = randomUUID();
        const agent = await this.api().agents.create({
          agentId,
          config: {
            provider: await this.resolveProvider(settings.workerProvider),
            modeId: mode,
            mcpServers: { "todo-board": this.deps.mcp({ TODO_CARD_ID: card.id, TODO_AGENT_ID: agentId, TODO_CWD: card.cwd }) },
          },
          cwd: card.cwd,
          title: `[투두] ${card.title}`,
          prompt,
          labels: { "todo-board/card": card.id },
        });
        return { ...card, agentId: agent.id };
      }
      case "create": {
        const provider = await this.resolveProvider(settings.reviewerProvider);
        const roles = rolesFor(effect.stage, effect.stage === "review" ? settings.reviewRoles : settings.qaRoles);
        const reviewers = [];
        for (const role of roles) {
          const agentId = randomUUID();
          const agent = await this.api().agents.create({
            agentId,
            config: {
              provider,
              modeId: settings.reviewerMode || undefined,
              mcpServers: { "todo-board": this.deps.mcp({ TODO_CARD_ID: card.id, TODO_AGENT_ID: agentId, TODO_STAGE: effect.stage, TODO_CWD: card.cwd }) },
            },
            cwd: card.cwd,
            title: `[투두 ${STAGE_LABELS[effect.stage]} · ${role.label}] ${card.title}`,
            prompt: stagePrompt(card, effect.stage, undefined, role),
            labels: { "todo-board/card": card.id, "todo-board/stage": effect.stage, "todo-board/role": role.id },
          });
          reviewers.push({ agentId: agent.id, role: role.id, label: role.label, status: null, summary: null });
        }
        return { ...card, reviewers };
      }
      case "finished":
        await this.releaseQueue(card.cwd);
        return card;
      case "none":
        return card;
    }
  }

  private async releaseQueue(cwd: string): Promise<void> {
    if (this.activeIn(cwd)) return;
    const next = this.store
      .all()
      .filter((card) => card.cwd === cwd && card.queued && card.stage === "todo")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next) await this.start(next.id);
  }

  private async lastText(agentId: string): Promise<string | null> {
    try {
      const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 });
      const texts = page.entries.flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : []));
      return texts.at(-1) ?? null;
    } catch {
      return null;
    }
  }

  /** Turn-end events are not replayed after a restart; a running session that is idle is treated as just ended. Queued cards get their turn. */
  private async reconcile(): Promise<void> {
    await this.processInbox();
    for (const cwd of new Set(this.store.all().filter((card) => card.queued).map((card) => card.cwd))) await this.releaseQueue(cwd);
    for (const card of this.store.all()) {
      if (card.state !== "running") continue;
      for (const agentId of responsibleAgents(card)) {
        if (card.reviewers.find((reviewer) => reviewer.agentId === agentId)?.status) continue;
        try {
          const handle = this.api().agents.ref(agentId);
          await handle.refresh();
          if (!handle.activeTurn) await this.onTurnEnded(agentId, { kind: "completed" });
        } catch (error) {
          await this.store.upsert({ ...card, state: "blocked", attention: `세션을 찾지 못함: ${(error as Error).message}`, updatedAt: new Date().toISOString() });
        }
      }
    }
  }
}
