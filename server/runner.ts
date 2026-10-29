import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type Card, type CardAction, type InboxMessage, STAGE_LABELS } from "../shared/board.ts";
import { BLOCKED_MARKER, planFile, stagePrompt } from "../shared/prompts.ts";
import { rolesFor } from "../shared/roles.ts";
import type { BoardSettingsValues } from "../shared/settings.ts";
import { commitAll, createDraftPr, gitHead, hasRemote, isGitRepo, pushBranch } from "./git.ts";
import { consume, readInbox } from "./inbox.ts";
import { type Effect, type IncomingReport, type TurnOutcome, advance, applyReport, applyTurnEnded, newCard, rejectToImplement, responsibleAgents, retryStage, start } from "./machine.ts";
import type { StdioMcpServer } from "./mcp.ts";
import type { BoardStore } from "./store.ts";

type Paseo = PluginHandlerContext["paseo"];

export interface RunnerDeps {
  store: BoardStore;
  inboxDir: string;
  settings: () => BoardSettingsValues;
  /** Builds the MCP server entry for a session the board creates. */
  mcp: (env: Record<string, string>) => StdioMcpServer;
}

export interface PermissionLike {
  name: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/** Permission prompts for the board's own MCP tools (Codex asks per MCP server; Claude names them mcp__<server>__<tool>). */
export const isBoardToolRequest = (request: PermissionLike): boolean =>
  request.metadata?.serverName === "todo-board" || request.name.startsWith("mcp__todo-board__") || /todo-board/i.test(request.title ?? "");

const workDir = (card: Card) => card.workCwd ?? card.cwd;
const stamp = () => new Date().toISOString();

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

  private get settings() {
    return this.deps.settings();
  }

  /** The planning turn reports through its last message when it runs in a read-only mode. */
  private planViaMessage(): boolean {
    return this.settings.planMode === "plan";
  }

  /** In-place cards share a working tree, so only one runs per directory. Worktree cards do not collide. */
  private activeIn(cwd: string, except?: string): boolean {
    return this.store.all().some((card) => card.cwd === cwd && card.id !== except && card.state === "running" && card.workCwd === card.cwd);
  }

  async add(input: { workspaceId: string | null; cwd: string; title: string; detail?: string }): Promise<Card> {
    return this.store.upsert(newCard(input));
  }

  /** The user's move: todo → plan. Gets the card a worktree (or the directory itself), then the planning turn. */
  async start(cardId: string): Promise<Card | null> {
    const card = this.store.get(cardId);
    if (!card || card.stage !== "todo") return card ?? null;
    const inPlace = !this.settings.useWorktree || !(await isGitRepo(card.cwd));
    if (!this.paseo || (inPlace && this.activeIn(card.cwd, card.id))) {
      return this.store.upsert({ ...card, queued: true, updatedAt: stamp() });
    }
    let placed: Card;
    try {
      placed = await this.place(card);
    } catch (error) {
      return this.store.upsert({ ...card, state: "blocked", attention: `worktree 생성 실패: ${(error as Error).message}`, updatedAt: stamp() });
    }
    const step = start({ ...placed, baseRef: await gitHead(workDir(placed)), queued: false });
    return this.commit(step.card, step.effect);
  }

  /** A Paseo worktree on branch `todo/<id>` when the card's directory is a git repository and worktrees are on. */
  private async place(card: Card): Promise<Card> {
    if (card.workCwd) return card;
    if (!this.settings.useWorktree || !(await isGitRepo(card.cwd))) return { ...card, workCwd: card.cwd };
    const branch = `todo/${card.id.slice(0, 8)}`;
    const workspace = await this.api().workspaces.create({
      source: { kind: "worktree", cwd: card.cwd, action: "branch-off", branchName: branch },
      title: `[투두] ${card.title}`,
    });
    const directory = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
    if (!directory) throw new Error("워크스페이스 디렉터리를 알 수 없습니다.");
    return { ...card, workCwd: directory, workWorkspaceId: workspace.id, branch };
  }

  async action(cardId: string, action: CardAction): Promise<Card | null> {
    const card = this.store.get(cardId);
    if (!card) return null;
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
        const done = await this.store.upsert({ ...card, stage: "done", state: "idle", reviewers: [], queued: false, attention: null, updatedAt: stamp() });
        void this.finish(done.id);
        return done;
      }
      case "delete":
        await this.store.remove(cardId);
        void this.archiveSessions(card.sessionIds);
        await this.releaseQueue(card.cwd);
        return null;
      case "pause":
        return this.store.upsert({ ...card, paused: true, updatedAt: stamp() });
      case "resume":
        return this.store.upsert({ ...card, paused: false, updatedAt: stamp() });
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
    let latest: IncomingReport | null = null;
    for (const entry of entries) {
      const { message } = entry;
      if (message.kind === "report") {
        if (message.cardId !== card.id) continue;
        // Team members report in parallel; only this session's report is consumed here.
        if (card.reviewers.length > 0 && message.agentId && message.agentId !== agentId) continue;
        latest = { stage: message.stage ?? card.stage, status: message.status, summary: message.summary };
        await consume(entry);
      } else {
        await consume(entry);
        if (message.kind === "add") await this.handleAdd(message);
        else await this.handleStart(message);
      }
    }
    if (!latest && card.stage === "plan" && this.planViaMessage() && outcome.kind === "completed") {
      const text = ((await this.lastText(agentId)) ?? "").trim();
      const blocked = text.startsWith(BLOCKED_MARKER);
      latest = { stage: "plan", status: blocked ? "blocked" : "done", summary: blocked ? text.slice(BLOCKED_MARKER.length).trim() : text };
      if (!text) latest = null;
    }
    if (latest) {
      if (card.stage === "plan" && latest.status === "done") await this.ensurePlanFile(card, latest.summary);
      const step = applyReport(card, latest, this.settings, agentId);
      await this.commit(step.card, step.effect);
      return;
    }
    await this.store.upsert(applyTurnEnded(card, outcome, await this.lastText(agentId), agentId));
  }

  /**
   * A message-mode planning turn must not leave plan mode or call tools; those prompts are declined with guidance.
   * Returns the message to deny with, or null to leave the request to the user.
   */
  permissionDecision(agentId: string, request: PermissionLike): string | null {
    const card = this.store.byAgent(agentId);
    if (!card || card.stage !== "plan" || card.agentId !== agentId || !this.planViaMessage()) return null;
    if (request.name === "ExitPlanMode") return "계획 승인은 필요 없습니다. 계획 전문을 마지막 메시지로 출력하고 턴을 끝내세요.";
    if (isBoardToolRequest(request)) return "계획 단계에서는 todo_report를 쓰지 않습니다. 계획 전문을 마지막 메시지로 출력하고 턴을 끝내세요.";
    return null;
  }

  async onPermission(agentId: string, pending: boolean): Promise<void> {
    const card = this.store.byAgent(agentId);
    if (!card || !responsibleAgents(card).includes(agentId)) return;
    const attention = pending ? "권한 요청 대기" : card.attention === "권한 요청 대기" ? null : card.attention;
    if (attention !== card.attention) await this.store.upsert({ ...card, attention, updatedAt: stamp() });
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

  /** A read-only planning turn cannot write files, so the plan text becomes the plan file (an existing file is kept). */
  private async ensurePlanFile(card: Card, summary: string): Promise<void> {
    const file = join(workDir(card), planFile(card));
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
      return this.store.upsert({ ...saved, state: "blocked", attention: `실행 실패: ${(error as Error).message}`, updatedAt: stamp() });
    }
  }

  /** Creates a session in the card's worktree workspace (or directory) with a chosen id so the MCP server can stamp its reports. */
  private async createSession(card: Card, options: { provider: string; modeId?: string; title: string; prompt: string; env: Record<string, string>; labels: Record<string, string> }): Promise<string> {
    const agentId = randomUUID();
    const config = { provider: options.provider, modeId: options.modeId, mcpServers: { "todo-board": this.deps.mcp({ TODO_CARD_ID: card.id, TODO_AGENT_ID: agentId, TODO_CWD: workDir(card), ...options.env }) } };
    const common = { agentId, config, title: options.title, prompt: options.prompt, labels: { "todo-board/card": card.id, ...options.labels } };
    const agent = card.workWorkspaceId
      ? await this.api().workspaces.ref(card.workWorkspaceId).agents.create(common)
      : await this.api().agents.create({ ...common, cwd: workDir(card) });
    return agent.id;
  }

  private async execute(card: Card, effect: Effect): Promise<Card> {
    const settings = this.settings;
    switch (effect.kind) {
      case "send": {
        const planViaMessage = effect.stage === "plan" && this.planViaMessage();
        const prompt = stagePrompt(card, effect.stage, { extra: effect.extra, planViaMessage });
        const mode = (effect.stage === "plan" ? settings.planMode || settings.workerMode : settings.workerMode) || undefined;
        if (card.agentId) {
          await this.api().agents.ref(card.agentId).send(prompt, { sessionMode: mode });
          return card;
        }
        const agentId = await this.createSession(card, {
          provider: await this.resolveProvider(settings.workerProvider),
          modeId: mode,
          title: `[투두] ${card.title}`,
          prompt,
          env: {},
          labels: {},
        });
        return { ...card, agentId, sessionIds: [...card.sessionIds, agentId] };
      }
      case "create": {
        const provider = await this.resolveProvider(settings.reviewerProvider);
        const roles = rolesFor(effect.stage, effect.stage === "review" ? settings.reviewRoles : settings.qaRoles);
        const reviewers = [];
        for (const role of roles) {
          const agentId = await this.createSession(card, {
            provider,
            modeId: settings.reviewerMode || undefined,
            title: `[투두 ${STAGE_LABELS[effect.stage]} · ${role.label}] ${card.title}`,
            prompt: stagePrompt(card, effect.stage, { role }),
            env: { TODO_STAGE: effect.stage },
            labels: { "todo-board/stage": effect.stage, "todo-board/role": role.id },
          });
          reviewers.push({ agentId, role: role.id, label: role.label, status: null, summary: null });
        }
        return { ...card, reviewers, sessionIds: [...card.sessionIds, ...reviewers.map((reviewer) => reviewer.agentId)] };
      }
      case "finished":
        // Runs on its own: pushing and opening a PR must not hold the lifecycle hook that triggered it.
        void this.finish(card.id);
        return card;
      case "none":
        return card;
    }
  }

  /** After completion: commit and push the branch, open a draft PR, then archive the sessions (and the worktree once the PR exists). */
  async finish(cardId: string): Promise<void> {
    let card = this.store.get(cardId);
    if (!card) return;
    const settings = this.settings;
    if (settings.createPr && card.branch && card.workCwd) {
      try {
        card = await this.store.upsert({ ...card, attention: "PR 만드는 중…", updatedAt: stamp() });
        const url = await this.openPr(card);
        card = await this.store.upsert({ ...card, prUrl: url, attention: null, updatedAt: stamp() });
      } catch (error) {
        console.error(`[todo-board] PR for ${card.id} failed`, error);
        card = await this.store.upsert({ ...card, attention: `PR 실패: ${(error as Error).message}`, updatedAt: stamp() });
      }
    }
    if (settings.autoArchive) {
      await this.archiveSessions(card.sessionIds);
      if (card.prUrl && card.workWorkspaceId) {
        await this.api().workspaces.ref(card.workWorkspaceId).archive().catch((error) => console.error("[todo-board] workspace archive", error));
      }
      card = await this.store.upsert({ ...card, sessionIds: [], updatedAt: stamp() });
    }
    await this.releaseQueue(card.cwd);
  }

  private async openPr(card: Card): Promise<string> {
    const cwd = card.workCwd!;
    // The work is committed on the card's branch even when it cannot be pushed.
    await commitAll(cwd, `[투두] ${card.title}`);
    if (!(await hasRemote(cwd))) throw new Error("origin 원격이 없습니다. 커밋은 브랜치에 남겼습니다.");
    await pushBranch(cwd, card.branch!);
    const plan = await readFile(join(cwd, planFile(card)), "utf8").catch(() => "(계획 파일 없음)");
    const reports = card.reports.map((report) => `- **${STAGE_LABELS[report.stage]}${report.role ? ` · ${report.role}` : ""}** ${report.status}: ${report.summary.split("\n")[0]}`).join("\n");
    const body = [card.detail ? `${card.detail}\n` : null, "## 계획", plan.trim(), "", "## 단계 보고", reports, "", "_Paseo 투두 보드가 만든 초안 PR_"].filter((line) => line !== null).join("\n");
    return createDraftPr(cwd, card.title, body);
  }

  private async archiveSessions(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.api()
        .agents.ref(id)
        .archive()
        .catch((error) => console.error(`[todo-board] archive ${id}`, error));
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
    // Only cards that were already running before this session arrived can have missed a turn end.
    const stale = this.store.all().filter((card) => card.state === "running");
    for (const cwd of new Set(this.store.all().filter((card) => card.queued).map((card) => card.cwd))) await this.releaseQueue(cwd);
    for (const card of stale) {
      for (const agentId of responsibleAgents(card)) {
        if (card.reviewers.find((reviewer) => reviewer.agentId === agentId)?.status) continue;
        try {
          const handle = this.api().agents.ref(agentId);
          await handle.refresh();
          if (!handle.activeTurn) await this.onTurnEnded(agentId, { kind: "completed" });
        } catch (error) {
          await this.store.upsert({ ...card, state: "blocked", attention: `세션을 찾지 못함: ${(error as Error).message}`, updatedAt: stamp() });
        }
      }
    }
  }
}
