import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type Card, type CardAction, type CardType, type InboxMessage, type RunMeta, STAGE_LABELS } from "../shared/board.ts";
import { BLOCKED_MARKER, type PromptCard, parseRating, plannedRepo, priorRounds, ratingPrompt, stagePrompt } from "../shared/prompts.ts";
import { recheckRoles, rolesFor } from "../shared/roles.ts";
import type { BoardSettingsValues } from "../shared/settings.ts";
import { childRepos, commitAll, createDraftPr, gitHead, hasRemote, isGitRepo, pushBranch } from "./git.ts";
import { consume, readInbox } from "./inbox.ts";
import { promptVersion, ratingVersion } from "./prompt-version.ts";
import { type Effect, type IncomingReport, type TurnOutcome, advance, applyReport, applyTurnEnded, newCard, rejectToImplement, responsibleAgents, retryStage, start } from "./machine.ts";
import type { BoardStore } from "./store.ts";
import { CARD_LABEL, STAGE_LABEL } from "./tools.ts";

type Paseo = PluginHandlerContext["paseo"];

export interface RunnerDeps {
  store: BoardStore;
  inboxDir: string;
  /** Plan files live here, outside every repository. */
  plansDir: string;
  settings: () => BoardSettingsValues;
}

export interface PermissionLike {
  name: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Permission prompts for the board's tools: plugin tools reach Claude as mcp__paseo__todo_*, pre-0.14 sessions as mcp__todo-board__*.
 * Codex asks per MCP server, and other Paseo tools share the `paseo` server, so only the legacy server matches there.
 */
export const isBoardToolRequest = (request: PermissionLike): boolean =>
  request.metadata?.serverName === "todo-board" || request.name.startsWith("mcp__todo-board__") || /^mcp__paseo__todo_(report|add|start|complete)$/.test(request.name) || /todo-board/i.test(request.title ?? "");

const workDir = (card: Card) => card.workCwd ?? card.cwd;
const planName = (card: Pick<Card, "id">) => `todo-${card.id.slice(0, 8)}.md`;
const stamp = () => new Date().toISOString();
/** Buttons and commands that count as a person stepping in; starting and deleting a card are normal use. */
const INTERVENTIONS: CardAction[] = ["advance", "retry", "reject", "complete", "pause"];

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

  /** In-place cards share a working tree, so only one runs per directory, and a card being rated still owns it. Worktree cards do not collide. */
  private activeIn(cwd: string, except?: string): boolean {
    return this.store.all().some((card) => card.cwd === cwd && card.id !== except && (card.state === "running" || card.aiRaterId !== null) && card.workCwd === card.cwd);
  }

  async add(input: { workspaceId: string | null; cwd: string; title: string; detail?: string; type?: CardType }): Promise<Card> {
    return this.store.add(newCard(input));
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
    const step = start({ ...placed, baseRef: await gitHead(workDir(placed)), queued: false, runMeta: await this.runMeta() });
    return this.commit(step.card, step.effect);
  }

  private async runMeta(): Promise<RunMeta> {
    const settings = this.settings;
    const resolved = (value: string) => this.resolveProvider(value).catch(() => value);
    return {
      promptVersion: promptVersion(),
      ratingVersion: ratingVersion(),
      worker: await resolved(settings.workerProvider),
      reviewer: await resolved(settings.reviewerProvider),
      workerMode: settings.workerMode,
      planMode: settings.planMode,
      reviewerMode: settings.reviewerMode,
      reviewRoles: settings.reviewRoles,
      qaRoles: settings.qaRoles,
    };
  }

  /** A person's rating of a finished card; it can change later, once the result has been used. */
  async rate(cardId: string, score: number, note?: string): Promise<Card | null> {
    const card = this.store.get(cardId);
    if (!card || card.stage !== "done") return card ?? null;
    const prev = card.userRating;
    const at = prev?.score === score ? prev.at : stamp();
    return this.store.annotate(cardId, { userRating: { score, note: note?.trim() || undefined, at, first: prev?.first ?? { score: prev?.score ?? score, at: prev?.at ?? at } } });
  }

  /** A Paseo worktree on branch `todo/<id>` when the card's directory is a git repository and worktrees are on. */
  private async place(card: Card): Promise<Card> {
    if (card.workCwd) return card;
    if (!this.settings.useWorktree || !(await isGitRepo(card.cwd))) return { ...card, workCwd: card.cwd };
    return this.createWorktree(card, card.cwd);
  }

  private async createWorktree(card: Card, repo: string): Promise<Card> {
    const branch = `todo/${card.id.slice(0, 8)}`;
    const workspace = await this.api().workspaces.create({
      source: { kind: "worktree", cwd: repo, action: "branch-off", branchName: branch },
      title: `[투두] ${card.title}`,
      background: this.settings.hideWorkspace,
    });
    const directory = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
    if (!directory) throw new Error("워크스페이스 디렉터리를 알 수 없습니다.");
    return { ...card, workCwd: directory, workWorkspaceId: workspace.id, branch };
  }

  /** Repositories a code card may still move into: its directory is not one, and it has no worktree yet. */
  private async linkableRepos(card: Card): Promise<string[]> {
    if (!this.settings.useWorktree || card.type === "doc" || card.branch || (await isGitRepo(card.cwd))) return [];
    return childRepos(card.cwd);
  }

  /**
   * A card from a folder of repositories plans there, then moves to a worktree of the repository its plan names.
   * A session cannot change directory, so implementation starts a new session, which gets the plan in its prompt.
   * Without a named repository the card keeps working in place.
   */
  private async linkRepo(card: Card): Promise<Card> {
    const repo = plannedRepo((await this.readPlan(card)) ?? "", await this.linkableRepos(card));
    if (!repo) return card;
    const placed = await this.createWorktree(card, join(card.cwd, repo));
    const linked = await this.store.upsert({ ...placed, baseRef: await gitHead(placed.workCwd!), agentId: null, sessionIds: placed.sessionIds.filter((id) => id !== card.agentId) });
    if (card.agentId) void this.archiveSessions([card.agentId]);
    return linked;
  }

  async action(cardId: string, action: CardAction): Promise<Card | null> {
    let card = this.store.get(cardId);
    if (!card) return null;
    if (card.stage === "done" && action !== "delete") return card;
    if (INTERVENTIONS.includes(action) && card.stage !== "todo") {
      await this.store.annotate(cardId, { events: [...card.events, { kind: "action", stage: card.stage, detail: action, at: stamp() }] });
      // The save gave other events a turn: act on what the card is now, not on the copy read above.
      card = this.store.get(cardId);
      if (!card) return null;
      if (card.stage === "done") return card;
    }
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
        void this.archiveSessions(card.aiRaterId ? [...card.sessionIds, card.aiRaterId] : card.sessionIds);
        // finishRating would have archived the workspace, but it no longer finds the card.
        if (card.aiRaterId && this.settings.autoArchive) void this.archiveWorkspace(card);
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
    const rated = this.store.all().find((item) => item.aiRaterId === agentId);
    if (rated) return this.finishRating(rated, agentId, outcome);
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
        await this.handleCommand(message);
      }
    }
    if (!latest && card.stage === "plan" && this.planViaMessage() && outcome.kind === "completed") {
      const text = ((await this.lastText(agentId)) ?? "").trim();
      const blocked = text.startsWith(BLOCKED_MARKER);
      latest = { stage: "plan", status: blocked ? "blocked" : "done", summary: blocked ? text.slice(BLOCKED_MARKER.length).trim() : text };
      if (!text) latest = null;
    }
    if (latest) {
      if (card.stage === "plan" && latest.status === "done") {
        await this.ensurePlanFile(card, latest.summary);
        try {
          await this.linkRepo(card);
        } catch (error) {
          await this.store.upsert({ ...card, state: "blocked", attention: `저장소 연결 실패: ${(error as Error).message}`, updatedAt: stamp() });
          return;
        }
      }
      // Team members end turns concurrently; apply to the card as it is now so no member's report is overwritten.
      const step = applyReport(this.store.get(card.id) ?? card, latest, this.settings, agentId);
      const after = await this.commit(step.card, step.effect);
      // A linked card has left the shared directory, so the next card there need not wait for it.
      if (after.workCwd !== after.cwd) await this.releaseQueue(after.cwd);
      // A team member is done once it has reported; it goes away at once instead of waiting for the card to complete.
      if (this.settings.autoArchive && card.reviewers.some((reviewer) => reviewer.agentId === agentId)) {
        await this.archiveSessions([agentId]);
        const current = this.store.get(after.id);
        if (current) await this.store.upsert({ ...current, sessionIds: current.sessionIds.filter((id) => id !== agentId) });
      }
      return;
    }
    const text = await this.lastText(agentId);
    await this.store.upsert(applyTurnEnded(this.store.get(card.id) ?? card, outcome, text, agentId));
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

  /** `todo_add`, `todo_start` and `todo_complete` take effect at once; reports wait for their session's turn to end. */
  async processInbox(): Promise<void> {
    for (const entry of await readInbox(this.deps.inboxDir)) {
      if (entry.message.kind === "report") continue;
      await consume(entry);
      await this.handleCommand(entry.message);
    }
  }

  private async handleCommand(message: Exclude<InboxMessage, { kind: "report" }>): Promise<void> {
    if (message.kind === "add") {
      await this.add({ workspaceId: await this.workspaceFor(message.cwd), cwd: message.cwd, title: message.title, detail: message.detail, type: message.type });
      return;
    }
    const query = message.query.toLowerCase();
    const inProgress = message.kind === "complete";
    const card = this.store
      .all()
      .filter((card) => card.cwd === message.cwd && (inProgress ? card.stage !== "todo" && card.stage !== "done" : card.stage === "todo"))
      .find((card) => card.id.startsWith(query) || card.title.toLowerCase().includes(query));
    if (!card) console.error(`[todo-board] ${message.kind}: no card matching "${message.query}" in ${message.cwd}`);
    else if (inProgress) await this.action(card.id, "complete");
    else await this.start(card.id);
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

  private planPath(card: Pick<Card, "id">): string {
    return join(this.deps.plansDir, planName(card));
  }

  private async readPlan(card: Card): Promise<string | null> {
    return readFile(this.planPath(card), "utf8").catch(() => null);
  }

  /** What prompts need to know about the card, including the plan text once it exists. */
  private async promptCard(card: Card): Promise<PromptCard> {
    return { id: card.id, title: card.title, detail: card.detail, baseRef: card.baseRef, planPath: this.planPath(card), plan: await this.readPlan(card), type: card.type, priorRounds: priorRounds(card.reports), repos: card.stage === "plan" ? await this.linkableRepos(card) : [] };
  }

  /** A read-only planning turn cannot write files, so the plan text becomes the plan file (an existing file is kept). */
  private async ensurePlanFile(card: Card, summary: string): Promise<void> {
    const file = this.planPath(card);
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

  /** Creates a session in the card's worktree workspace (or directory); its labels give it `todo_report` for this card and stage. */
  private async createSession(card: Card, options: { provider: string; modeId?: string; title: string; prompt: string; labels: Record<string, string> }): Promise<string> {
    const agentId = randomUUID();
    const config = { provider: options.provider, modeId: options.modeId };
    const common = { agentId, config, title: options.title, prompt: options.prompt, labels: options.labels };
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
        const prompt = stagePrompt(await this.promptCard(card), effect.stage, { extra: effect.extra, planViaMessage });
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
          labels: { [CARD_LABEL]: card.id },
        });
        return { ...card, agentId, sessionIds: [...card.sessionIds, agentId] };
      }
      case "create": {
        const provider = await this.resolveProvider(settings.reviewerProvider);
        const team = rolesFor(effect.stage, effect.stage === "review" ? settings.reviewRoles : settings.qaRoles, card.type);
        const roles = effect.stage === "review" ? recheckRoles(team, card.reports) : team;
        const promptCard = await this.promptCard(card);
        const reviewers = [];
        for (const role of roles) {
          const agentId = await this.createSession(card, {
            provider,
            modeId: settings.reviewerMode || undefined,
            title: `[투두 ${STAGE_LABELS[effect.stage]} · ${role.label}] ${card.title}`,
            prompt: stagePrompt(promptCard, effect.stage, { role }),
            labels: { [CARD_LABEL]: card.id, [STAGE_LABEL]: effect.stage, "todo-board/role": role.id },
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

  /** After completion: commit and push the branch, open a draft PR, start the AI rating, then archive the sessions (and the worktree once the PR exists and the rating is over). */
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
    const rating = await this.startRating(card);
    if (settings.autoArchive) {
      await this.archiveSessions(card.sessionIds);
      if (!rating) await this.archiveWorkspace(card);
      card = await this.store.upsert({ ...card, sessionIds: [], updatedAt: stamp() });
    }
    await this.releaseQueue(card.cwd);
  }

  private async archiveWorkspace(card: Card): Promise<void> {
    if (!card.prUrl || !card.workWorkspaceId) return;
    await this.api().workspaces.ref(card.workWorkspaceId).archive().catch((error) => console.error("[todo-board] workspace archive", error));
  }

  /** A fresh session rates the result in the background; it never holds the card, its queue or its PR. A card nobody worked on has nothing to rate. */
  private async startRating(card: Card): Promise<boolean> {
    if (!this.settings.aiRating || !card.agentId || card.aiRating) return false;
    try {
      const settings = this.settings;
      const agentId = await this.createSession(card, {
        provider: await this.resolveProvider(settings.reviewerProvider),
        modeId: settings.reviewerMode || undefined,
        title: `[투두 평가] ${card.title}`,
        prompt: ratingPrompt(await this.promptCard(card)),
        labels: {},
      });
      if (await this.store.annotate(card.id, { aiRaterId: agentId })) return true;
      // Deleted while the session was starting: nothing would ever collect it.
      await this.archiveSessions([agentId]);
      return false;
    } catch (error) {
      console.error(`[todo-board] rating for ${card.id} failed`, error);
      await this.store.annotate(card.id, { aiRating: { score: null, reason: `평가 세션 시작 실패: ${(error as Error).message}`, at: stamp() } });
      return false;
    }
  }

  private async finishRating(card: Card, agentId: string, outcome: TurnOutcome): Promise<void> {
    const text = outcome.kind === "completed" ? await this.lastText(agentId) : null;
    const parsed = text ? parseRating(text) : null;
    const reason = parsed?.reason ?? (outcome.kind === "failed" ? `오류: ${outcome.error.message}` : outcome.kind === "canceled" ? `취소됨: ${outcome.reason}` : `점수를 읽지 못함: ${(text ?? "").slice(0, 200)}`);
    const after = await this.store.annotate(card.id, { aiRaterId: null, aiRating: { score: parsed?.score ?? null, reason, at: stamp() } });
    if (this.settings.autoArchive) {
      await this.archiveSessions([agentId]);
      if (after) await this.archiveWorkspace(after);
    }
    await this.releaseQueue(card.cwd);
  }

  private async openPr(card: Card): Promise<string> {
    const cwd = card.workCwd!;
    // The work is committed on the card's branch even when it cannot be pushed.
    await commitAll(cwd, `[투두] ${card.title}`);
    if (!(await hasRemote(cwd))) throw new Error("origin 원격이 없습니다. 커밋은 브랜치에 남겼습니다.");
    await pushBranch(cwd, card.branch!);
    const plan = (await this.readPlan(card)) ?? "(계획 파일 없음)";
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
    const rating = this.store.all().filter((card) => card.aiRaterId);
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
    for (const card of rating) {
      const agentId = card.aiRaterId!;
      try {
        const handle = this.api().agents.ref(agentId);
        await handle.refresh();
        if (!handle.activeTurn) await this.finishRating(card, agentId, { kind: "completed" });
      } catch (error) {
        await this.finishRating(card, agentId, { kind: "failed", error: { message: (error as Error).message } });
      }
    }
  }
}
