import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, isBoardToolRequest } from "../server/runner.ts";
import { BoardStore } from "../server/store.ts";
import { boardSettings } from "../shared/settings.ts";

/** Enough of the Paseo SDK for the runner: creation honours the requested id, sends and archives are recorded, timelines hold one answer. */
function fakePaseo() {
  const created: any[] = [];
  const sent: { agentId: string; text: string; options: any }[] = [];
  const workspacesCreated: any[] = [];
  const archived: string[] = [];
  const lastText = { value: "마지막 답" };
  const agentsApi = (workspaceId: string | null) => ({
    create: async (options: any) => {
      created.push({ ...options, workspaceId });
      return { id: options.agentId };
    },
  });
  const paseo = {
    agents: {
      ...agentsApi(null),
      ref: (agentId: string) => ({
        activeTurn: null,
        send: async (text: string, options: any) => void sent.push({ agentId, text, options }),
        refresh: async () => null,
        archive: async () => void archived.push(agentId),
        timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: lastText.value } }] }) },
      }),
    },
    workspaces: {
      list: async () => ({ entries: [] }),
      create: async (options: any) => {
        workspacesCreated.push(options);
        return { id: `wks-${workspacesCreated.length}`, directory: options.source.cwd, refresh: async () => null };
      },
      ref: (workspaceId: string) => ({ agents: agentsApi(workspaceId), archive: async () => void archived.push(`workspace:${workspaceId}`) }),
    },
    providers: { listModels: async (provider: string) => ({ models: [{ id: "m-old" }, { id: `${provider}-default`, isDefault: true }] }) },
  };
  return { paseo: paseo as any, created, sent, workspacesCreated, archived, lastText };
}

const exec = promisify(execFile);
async function gitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "todo-repo-"));
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await exec("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

async function setup(overrides: Partial<ReturnType<typeof boardSettings.schema.parse>> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "todo-runner-"));
  const store = new BoardStore(join(dir, "board.json"));
  await store.load();
  const inboxDir = join(dir, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const plansDir = join(dir, "plans");
  const fake = fakePaseo();
  const runner = new Runner({
    store,
    inboxDir,
    plansDir,
    settings: () => ({ ...boardSettings.schema.parse({}), ...overrides }),
  });
  const report = (cardId: string, agentId: string, status: string, summary: string, stage?: string) =>
    writeFile(join(inboxDir, `${Date.now()}-${Math.random()}.json`), JSON.stringify({ kind: "report", cardId, agentId, stage, status, summary }));
  return { dir, store, runner, inboxDir, plansDir, report, attach: () => runner.attach(fake.paseo), ...fake };
}

test("start creates the worker with a chosen id and the card label; the plan turn may use its own mode", async () => {
  const { runner, store, created, sent, report, attach, dir, plansDir } = await setup({ planMode: "plan", useWorktree: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: dir, title: "기능 A" });
  let current = (await runner.start(card.id))!;
  assert.equal(current.stage, "plan");
  assert.equal(current.agentId, created[0].agentId);
  assert.equal(created[0].config.modeId, "plan");
  assert.equal(created[0].labels["todo-board/card"], card.id);
  assert.equal(created[0].labels["todo-board/stage"], undefined);
  assert.equal(created[0].config.provider, "claude/claude-default");
  assert.match(created[0].prompt, /현재 단계: 계획/);

  await report(card.id, current.agentId!, "done", "1. 파일 수정\n2. 테스트");
  await runner.onTurnEnded(current.agentId!, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(sent.at(-1)?.agentId, current.agentId);
  assert.equal(sent.at(-1)?.options.sessionMode, "auto");
  assert.match(sent.at(-1)!.text, /현재 단계: 구현/);
  // Plan mode cannot write files, so the report became the plan file, outside the repository, and the next prompt carries it.
  assert.match(await readFile(join(plansDir, `todo-${card.id.slice(0, 8)}.md`), "utf8"), /기능 A[\s\S]*1\. 파일 수정/);
  assert.match(sent.at(-1)!.text, /<plan>[\s\S]*1\. 파일 수정[\s\S]*<\/plan>/);
});

test("review fans out one session per enabled role; the card moves once every member has reported", async () => {
  const { runner, store, created, sent, report, attach, archived } = await setup({ reviewRoles: "security,tests", qaRoles: "qa-run" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "B" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  await report(card.id, worker, "done", "p");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await report(card.id, worker, "done", "i");
  await runner.onTurnEnded(worker, { kind: "completed" });
  let current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.deepEqual(current.reviewers.map((r) => r.role), ["security", "tests"]);
  assert.equal(created.length, 3);
  assert.equal(created[1].config.provider, "codex/codex-default");
  assert.equal(created[1].config.modeId, "full-access");
  assert.match(created[1].title, /검토 · 보안/);
  assert.match(created[2].prompt, /테스트로 검증/);
  const [security, tests] = current.reviewers.map((r) => r.agentId);

  // Both report into the same inbox; each turn end only consumes its own report.
  await report(card.id, security, "done", "안전", "review");
  await report(card.id, tests, "fail", "테스트 없음", "review");
  await runner.onTurnEnded(security, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.equal(current.reviewers.find((r) => r.agentId === security)?.status, "done");
  assert.equal(current.reviewers.find((r) => r.agentId === tests)?.status, null);
  // A member that has reported is archived right away and no longer waits for completion.
  assert.deepEqual(archived, [security]);
  assert.equal(current.sessionIds.includes(security), false);
  assert.equal(current.sessionIds.includes(tests), true);
  await runner.onTurnEnded(tests, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.retries, 1);
  assert.match(sent.at(-1)!.text, /\[테스트 적정성\]\n테스트 없음/);

  // A turn from a session that is not responsible for the stage leaves the card alone.
  await runner.onTurnEnded(security, { kind: "completed" });
  assert.equal(store.get(card.id)!.stage, "implement");
});

test("a team member that ends without reporting blocks the stage with its role named", async () => {
  const { runner, store, report, attach } = await setup({ reviewRoles: "tests" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "C" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  for (const stage of ["plan", "implement"]) {
    await report(card.id, worker, "done", stage);
    await runner.onTurnEnded(worker, { kind: "completed" });
  }
  const reviewer = store.get(card.id)!.reviewers[0].agentId;
  await runner.onTurnEnded(reviewer, { kind: "completed" });
  const blocked = store.get(card.id)!;
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.attention, "테스트 적정성: 보고 없음: 마지막 답");
});

test("one card runs per directory; the next queued card starts when the first completes", async () => {
  const { runner, store, attach } = await setup({ aiRating: false });
  attach();
  const first = await runner.add({ workspaceId: "w", cwd: "/x", title: "1" });
  const second = await runner.add({ workspaceId: "w", cwd: "/x", title: "2" });
  await runner.start(first.id);
  const queued = (await runner.start(second.id))!;
  assert.equal(queued.stage, "todo");
  assert.equal(queued.queued, true);
  await runner.action(first.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.get(second.id)!.stage, "plan");
  assert.equal(store.get(second.id)!.queued, false);
});

test("todo_start from chat starts the matching todo card in that directory", async () => {
  const { runner, store, inboxDir, attach } = await setup();
  attach();
  const other = await runner.add({ workspaceId: "w", cwd: "/y", title: "로그인 수정" });
  const target = await runner.add({ workspaceId: "w", cwd: "/x", title: "로그인 수정" });
  await writeFile(join(inboxDir, "s.json"), JSON.stringify({ kind: "start", cwd: "/x", query: "로그인" }));
  await runner.processInbox();
  assert.equal(store.get(target.id)!.stage, "plan");
  assert.equal(store.get(other.id)!.stage, "todo");
});

test("a start before any daemon session queues the card; the first session starts it", async () => {
  const { runner, store, attach, created } = await setup();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "early" });
  const queued = (await runner.start(card.id))!;
  assert.equal(queued.queued, true);
  attach();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.get(card.id)!.stage, "plan");
  assert.equal(created.length, 1);
});

test("todo_add messages in the inbox become cards", async () => {
  const { runner, store, inboxDir } = await setup();
  await writeFile(join(inboxDir, "a.json"), JSON.stringify({ kind: "add", cwd: "/x", title: "세션에서 추가" }));
  await runner.processInbox();
  assert.equal(store.all()[0]?.title, "세션에서 추가");
});

test("a git directory gets a worktree workspace on todo/<id>, and sessions are created inside it", async () => {
  const { runner, store, created, workspacesCreated, attach } = await setup();
  attach();
  const repo = await gitDir();
  const card = await runner.add({ workspaceId: "w", cwd: repo, title: "브랜치 작업" });
  const started = (await runner.start(card.id))!;
  assert.equal(started.branch, `todo/${card.id.slice(0, 8)}`);
  assert.equal(started.workWorkspaceId, "wks-1");
  assert.equal(started.workCwd, repo);
  assert.equal(started.baseRef?.length, 40);
  assert.deepEqual(workspacesCreated[0].source, { kind: "worktree", cwd: repo, action: "branch-off", branchName: started.branch });
  assert.equal(workspacesCreated[0].background, true);
  assert.equal(created[0].workspaceId, "wks-1");
  assert.equal(created[0].cwd, undefined);
  assert.deepEqual(started.sessionIds, [started.agentId]);
  // Two worktree cards in one directory run side by side.
  const second = await runner.add({ workspaceId: "w", cwd: repo, title: "둘째" });
  assert.equal((await runner.start(second.id))!.stage, "plan");
});

test("hideWorkspace=false makes a visible worktree workspace", async () => {
  const { runner, workspacesCreated, attach } = await setup({ hideWorkspace: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: await gitDir(), title: "보이게" });
  await runner.start(card.id);
  assert.equal(workspacesCreated[0].background, false);
});

test("a non-git directory works in place: no worktree, one card at a time", async () => {
  const { runner, store, workspacesCreated, attach } = await setup();
  attach();
  const first = await runner.add({ workspaceId: "w", cwd: "/not-a-repo", title: "1" });
  const started = (await runner.start(first.id))!;
  assert.equal(started.workCwd, "/not-a-repo");
  assert.equal(started.branch, null);
  assert.equal(workspacesCreated.length, 0);
  const second = await runner.add({ workspaceId: "w", cwd: "/not-a-repo", title: "2" });
  assert.equal((await runner.start(second.id))!.queued, true);
  assert.equal(store.get(second.id)!.stage, "todo");
});

test("in plan mode the plan is the last message: it becomes the plan file and moves the card; BLOCKED: blocks it", async () => {
  const { runner, store, attach, lastText, dir, plansDir } = await setup({ useWorktree: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: dir, title: "메시지 계획" });
  const started = (await runner.start(card.id))!;
  lastText.value = "# 계획\n1. a.ts 수정\n2. 테스트";
  await runner.onTurnEnded(started.agentId!, { kind: "completed" });
  let current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.reports[0]?.summary, lastText.value);
  assert.match(await readFile(join(plansDir, `todo-${card.id.slice(0, 8)}.md`), "utf8"), /1\. a\.ts 수정/);

  const other = await runner.add({ workspaceId: "w", cwd: "/elsewhere", title: "질문" });
  const otherStarted = (await runner.start(other.id))!;
  lastText.value = "BLOCKED: 어느 DB를 쓰나요?";
  await runner.onTurnEnded(otherStarted.agentId!, { kind: "completed" });
  current = store.get(other.id)!;
  assert.equal(current.state, "blocked");
  assert.equal(current.reports[0]?.summary, "어느 DB를 쓰나요?");
});

test("during a message-mode planning turn, plan approval and board tool prompts are declined with guidance", async () => {
  const { runner, store, attach } = await setup();
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/p", title: "권한" });
  const started = (await runner.start(card.id))!;
  assert.match(runner.permissionDecision(started.agentId!, { name: "ExitPlanMode" }) ?? "", /마지막 메시지/);
  assert.match(runner.permissionDecision(started.agentId!, { name: "mcp__todo-board__todo_report" }) ?? "", /todo_report/);
  assert.equal(runner.permissionDecision(started.agentId!, { name: "Bash" }), null);
  assert.equal(runner.permissionDecision("stranger", { name: "ExitPlanMode" }), null);
  await store.upsert({ ...store.get(card.id)!, stage: "implement" });
  assert.equal(runner.permissionDecision(started.agentId!, { name: "ExitPlanMode" }), null);
});

test("finishing archives every session of the card; the worktree stays when no PR was made", async () => {
  const { runner, store, archived, attach } = await setup({ createPr: false, reviewRoles: "tests", qaRoles: "qa-run" });
  attach();
  const repo = await gitDir();
  const card = await runner.add({ workspaceId: "w", cwd: repo, title: "정리" });
  await runner.start(card.id);
  const sessions = store.get(card.id)!.sessionIds;
  assert.equal(sessions.length, 1);
  await runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const done = store.get(card.id)!;
  assert.equal(done.stage, "done");
  assert.deepEqual(archived, sessions);
  assert.deepEqual(done.sessionIds, []);
  assert.equal(done.prUrl, null);
});

test("without an origin the work is still committed on the branch and the card says why there is no PR", async () => {
  const { runner, store, attach } = await setup({ useWorktree: false, createPr: true, autoArchive: false });
  attach();
  const repo = await gitDir();
  await exec("git", ["-c", "user.email=t@e", "-c", "user.name=t", "checkout", "-q", "-b", "todo/x"], { cwd: repo });
  await writeFile(join(repo, "new.txt"), "x\n");
  const card = await runner.add({ workspaceId: "w", cwd: repo, title: "원격 없음" });
  await store.upsert({ ...store.get(card.id)!, workCwd: repo, branch: "todo/x" });
  await runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const done = store.get(card.id)!;
  assert.match(done.attention ?? "", /origin 원격이 없습니다/);
  assert.equal(done.prUrl, null);
  const log = await exec("git", ["log", "--oneline"], { cwd: repo });
  assert.match(log.stdout, /\[투두\] 원격 없음/);
});

test("only the board's own MCP tool prompts are recognised", () => {
  assert.equal(isBoardToolRequest({ name: "CodexMcpElicitation", title: "MCP approval: todo-board", metadata: { serverName: "todo-board" } }), true);
  assert.equal(isBoardToolRequest({ name: "mcp__todo-board__todo_report" }), true);
  assert.equal(isBoardToolRequest({ name: "mcp__paseo__todo_report" }), true);
  assert.equal(isBoardToolRequest({ name: "mcp__paseo__todo_complete" }), true);
  assert.equal(isBoardToolRequest({ name: "mcp__paseo__create_agent" }), false);
  assert.equal(isBoardToolRequest({ name: "CodexMcpElicitation", title: "MCP approval: paseo", metadata: { serverName: "paseo" } }), false);
  assert.equal(isBoardToolRequest({ name: "Bash", title: "rm -rf /" }), false);
});

test("a team reviewing again gets the earlier rejections and fixes; the first team does not", async () => {
  const { runner, store, created, report, attach } = await setup({ reviewRoles: "correctness", qaRoles: "qa-acceptance" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "B" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  await report(card.id, worker, "done", "계획");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await report(card.id, worker, "done", "구현");
  await runner.onTurnEnded(worker, { kind: "completed" });
  assert.doesNotMatch(created.at(-1).prompt, /<prior>/);
  const first = store.get(card.id)!.reviewers[0].agentId;
  await report(card.id, first, "fail", "표 누락", "review");
  await runner.onTurnEnded(first, { kind: "completed" });
  await report(card.id, worker, "done", "표 추가");
  await runner.onTurnEnded(worker, { kind: "completed" });
  assert.equal(store.get(card.id)!.stage, "review");
  assert.match(created.at(-1).prompt, /<prior>[\s\S]*표 누락[\s\S]*표 추가[\s\S]*<\/prior>/);
});

test("a doc card added from chat runs one reviewer and one acceptance check through to done", async () => {
  const { runner, store, created, report, inboxDir, attach } = await setup();
  attach();
  await writeFile(join(inboxDir, "a.json"), JSON.stringify({ kind: "add", cwd: "/x", title: "조사", type: "doc" }));
  await runner.processInbox();
  const card = store.all()[0];
  assert.equal(card.type, "doc");
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  await report(card.id, worker, "done", "계획");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await report(card.id, worker, "done", "보고서 작성");
  await runner.onTurnEnded(worker, { kind: "completed" });
  assert.deepEqual(store.get(card.id)!.reviewers.map((r) => r.role), ["correctness"]);
  const reviewer = store.get(card.id)!.reviewers[0].agentId;
  await report(card.id, reviewer, "done", "일치", "review");
  await runner.onTurnEnded(reviewer, { kind: "completed" });
  assert.deepEqual(store.get(card.id)!.reviewers.map((r) => r.role), ["qa-acceptance"]);
  const qa = store.get(card.id)!.reviewers[0].agentId;
  await report(card.id, qa, "done", "충족", "qa");
  await runner.onTurnEnded(qa, { kind: "completed" });
  assert.equal(store.get(card.id)!.stage, "done");
  // Worker, one reviewer, one acceptance check, and the rating session.
  assert.equal(created.length, 4);
});

test("cards saved before card types load as code cards", async () => {
  const { runner, store, dir } = await setup();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "옛 카드" });
  const saved = JSON.parse(await readFile(join(dir, "board.json"), "utf8"));
  const cards = Array.isArray(saved) ? saved : saved.cards;
  delete cards.find((item: { id: string }) => item.id === card.id).type;
  await writeFile(join(dir, "board.json"), JSON.stringify(saved));
  const reloaded = new BoardStore(join(dir, "board.json"));
  await reloaded.load();
  assert.equal(reloaded.get(card.id)?.type, "code");
  assert.equal(store.get(card.id)?.title, "옛 카드");
});

test("todo_complete from chat completes a stuck card in that directory and leaves others alone", async () => {
  const { runner, store, inboxDir, attach, archived } = await setup();
  attach();
  const elsewhere = await runner.add({ workspaceId: "w", cwd: "/y", title: "RPC 현황" });
  const waiting = await runner.add({ workspaceId: "w", cwd: "/x", title: "RPC 대기" });
  const stuck = await runner.add({ workspaceId: "w", cwd: "/x", title: "RPC 현황" });
  await store.upsert({ ...stuck, stage: "review", state: "needs_human", attention: "재시도 상한 초과", agentId: "worker", sessionIds: ["worker"] });
  await writeFile(join(inboxDir, "c.json"), JSON.stringify({ kind: "complete", cwd: "/x", query: "RPC" }));
  await runner.processInbox();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const done = store.get(stuck.id)!;
  assert.equal(done.stage, "done");
  assert.equal(done.attention, null);
  assert.deepEqual(archived, ["worker"]);
  assert.equal(store.get(waiting.id)!.stage, "todo");
  assert.equal(store.get(elsewhere.id)!.stage, "todo");
});

/** A card walked to completion through the buttons, with its PR and rating flow running. */
async function finished(overrides: Partial<ReturnType<typeof boardSettings.schema.parse>> = {}) {
  const context = await setup({ useWorktree: false, createPr: false, ...overrides });
  context.attach();
  const card = await context.runner.add({ workspaceId: "w", cwd: "/x", title: "평가 대상" });
  await context.runner.start(card.id);
  await context.runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { ...context, card };
}

test("start records what the card runs with", async () => {
  const { runner, store, attach } = await setup({ useWorktree: false, reviewRoles: "security" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "C" });
  await runner.start(card.id);
  const meta = store.get(card.id)!.runMeta!;
  assert.match(meta.promptVersion, /^[0-9a-f]{8}$/);
  assert.equal(meta.worker, "claude/claude-default");
  assert.equal(meta.reviewer, "codex/codex-default");
  assert.equal(meta.reviewRoles, "security");
  assert.deepEqual(store.get(card.id)!.events.map((event) => event.stage), ["plan"]);
});

test("completion starts a rating session without the card's report tool, and its last message becomes the AI rating", async () => {
  const { store, created, archived, runner, lastText, card } = await finished();
  const rater = created.at(-1);
  assert.match(rater.title, /투두 평가/);
  assert.match(rater.prompt, /점수: N/);
  assert.equal(rater.labels["todo-board/card"], undefined);
  assert.equal(rater.config.provider, "codex/codex-default");
  assert.equal(store.get(card.id)!.aiRaterId, rater.agentId);
  assert.equal(archived.includes(rater.agentId), false);

  lastText.value = "점수: 4\n수용 기준 충족";
  await runner.onTurnEnded(rater.agentId, { kind: "completed" });
  const current = store.get(card.id)!;
  assert.equal(current.aiRaterId, null);
  assert.equal(current.aiRating?.score, 4);
  assert.equal(current.aiRating?.reason, "수용 기준 충족");
  assert.equal(archived.includes(rater.agentId), true);
  assert.equal(current.stage, "done");
});

test("a rating that cannot be read or fails is recorded without a score and does not touch the card", async () => {
  const unreadable = await finished();
  unreadable.lastText.value = "좋아 보입니다";
  await unreadable.runner.onTurnEnded(unreadable.created.at(-1).agentId, { kind: "completed" });
  assert.equal(unreadable.store.get(unreadable.card.id)!.aiRating?.score, null);
  assert.match(unreadable.store.get(unreadable.card.id)!.aiRating!.reason, /점수를 읽지 못함: 좋아 보입니다/);

  const failed = await finished();
  await failed.runner.onTurnEnded(failed.created.at(-1).agentId, { kind: "failed", error: { message: "한도 초과" } });
  assert.match(failed.store.get(failed.card.id)!.aiRating!.reason, /오류: 한도 초과/);
  assert.equal(failed.store.get(failed.card.id)!.stage, "done");
});

test("the worktree workspace is archived only after the rating ends, and a rating that cannot start falls back at once", async () => {
  const context = await setup({ createPr: false });
  const dir = await gitDir();
  context.attach();
  const card = await context.runner.add({ workspaceId: "w", cwd: dir, title: "W" });
  await context.runner.start(card.id);
  await context.store.upsert({ ...context.store.get(card.id)!, prUrl: "https://pr" });
  await context.runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rater = context.created.at(-1);
  assert.equal(rater.workspaceId, "wks-1");
  assert.equal(context.archived.includes("workspace:wks-1"), false);
  await context.runner.onTurnEnded(rater.agentId, { kind: "completed" });
  assert.equal(context.archived.includes("workspace:wks-1"), true);

  const broken = await setup({ useWorktree: false, createPr: false });
  broken.attach();
  const other = await broken.runner.add({ workspaceId: "w", cwd: "/x", title: "실패" });
  await broken.runner.start(other.id);
  broken.paseo.providers.listModels = async () => ({ models: [] });
  await broken.runner.action(other.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(broken.store.get(other.id)!.aiRating!.reason, /평가 세션 시작 실패/);
  assert.equal(broken.store.get(other.id)!.aiRaterId, null);
});

test("an in-place card holds its directory until the rating ends, so the next card's changes stay out of its diff", async () => {
  const context = await setup({ useWorktree: false, createPr: false });
  context.attach();
  const first = await context.runner.add({ workspaceId: "w", cwd: "/x", title: "먼저" });
  const second = await context.runner.add({ workspaceId: "w", cwd: "/x", title: "다음" });
  await context.runner.start(first.id);
  await context.runner.start(second.id);
  assert.equal(context.store.get(second.id)!.queued, true);
  await context.runner.action(first.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rater = context.store.get(first.id)!.aiRaterId!;
  assert.equal(context.store.get(second.id)!.stage, "todo");
  await context.runner.onTurnEnded(rater, { kind: "completed" });
  assert.equal(context.store.get(second.id)!.stage, "plan");
});

test("a card nobody worked on gets no rating session", async () => {
  const { runner, store, created, attach } = await setup({ useWorktree: false, createPr: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "빈 카드" });
  await store.upsert({ ...card, stage: "implement" });
  await runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(created.length, 0);
  assert.equal(store.get(card.id)!.aiRating, null);
});

test("a rating left running by a restart is collected on attach", async () => {
  const context = await finished();
  const rater = context.created.at(-1);
  context.lastText.value = "점수: 2\n아쉬움";
  const restarted = new Runner({ store: context.store, inboxDir: context.inboxDir, plansDir: context.plansDir, settings: () => boardSettings.schema.parse({}) });
  restarted.attach(context.paseo);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.store.get(context.card.id)!.aiRating?.score, 2);
  assert.equal(context.store.get(context.card.id)!.aiRaterId, null);
  assert.equal(context.archived.includes(rater.agentId), true);
});

test("a person can rate and re-rate only a finished card, and the AI rating stays untouched", async () => {
  const { runner, store, lastText, created, card } = await finished();
  lastText.value = "점수: 3\n보통";
  await runner.onTurnEnded(created.at(-1).agentId, { kind: "completed" });
  assert.equal((await runner.rate(card.id, 5, " 좋음 "))?.userRating?.note, "좋음");
  const again = await runner.rate(card.id, 2);
  assert.equal(again?.userRating?.score, 2);
  assert.equal(again?.userRating?.note, undefined);
  assert.equal(again?.userRating?.first?.score, 5);
  const noted = await runner.rate(card.id, 2, "이유만 수정");
  assert.equal(noted?.userRating?.at, again?.userRating?.at);
  assert.equal(noted?.userRating?.first?.score, 5);
  assert.equal(store.get(card.id)!.aiRating?.score, 3);
  assert.equal(await runner.rate("없음", 3), null);

  const open = await runner.add({ workspaceId: "w", cwd: "/y", title: "미완료" });
  assert.equal((await runner.rate(open.id, 5))?.userRating, null);
});

test("stepping in is recorded on the timeline; starting a card is not", async () => {
  const { runner, store, attach } = await setup({ useWorktree: false, createPr: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "개입" });
  await runner.action(card.id, "start");
  await runner.action(card.id, "pause");
  await runner.action(card.id, "resume");
  await runner.action(card.id, "advance");
  const events = store.get(card.id)!.events;
  assert.deepEqual(events.filter((event) => event.kind === "action").map((event) => event.detail), ["pause", "advance"]);
  assert.deepEqual(events.filter((event) => event.kind === "stage").map((event) => event.stage), ["plan", "implement"]);
});

test("the AI rating can be turned off", async () => {
  const { created, store, card } = await finished({ aiRating: false });
  assert.equal(created.some((session) => /투두 평가/.test(session.title)), false);
  assert.equal(store.get(card.id)!.aiRaterId, null);
});

test("pressing complete twice finishes once, sequentially or at the same moment", async () => {
  const context = await setup({ useWorktree: false, createPr: false });
  context.attach();
  const card = await context.runner.add({ workspaceId: "w", cwd: "/x", title: "두 번" });
  await context.runner.start(card.id);
  await Promise.all([context.runner.action(card.id, "complete"), context.runner.action(card.id, "complete")]);
  await context.runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.created.filter((session) => /투두 평가/.test(session.title)).length, 1);
});

test("deleting a card while its rating starts or runs leaves no session or workspace behind", async () => {
  const context = await setup({ useWorktree: false, createPr: false });
  context.attach();
  const card = await context.runner.add({ workspaceId: "w", cwd: "/x", title: "삭제" });
  await context.runner.start(card.id);
  const create = context.paseo.agents.create;
  context.paseo.agents.create = async (options: any) => {
    await context.store.remove(card.id);
    return create(options);
  };
  await context.runner.action(card.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.store.get(card.id), undefined);
  assert.equal(context.archived.includes(context.created.at(-1).agentId), true);

  const running = await setup({ createPr: false });
  const dir = await gitDir();
  running.attach();
  const other = await running.runner.add({ workspaceId: "w", cwd: dir, title: "평가 중 삭제" });
  await running.runner.start(other.id);
  await running.store.upsert({ ...running.store.get(other.id)!, prUrl: "https://pr" });
  await running.runner.action(other.id, "complete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await running.runner.action(other.id, "delete");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(running.archived.includes("workspace:wks-1"), true);
});

test("team members ending turns at the same moment both count", async () => {
  const { runner, store, report, attach } = await setup({ useWorktree: false, reviewRoles: "security,tests", qaRoles: "qa-run" });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "동시" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  await report(card.id, worker, "done", "p");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await report(card.id, worker, "done", "i");
  await runner.onTurnEnded(worker, { kind: "completed" });
  const [a, b] = store.get(card.id)!.reviewers.map((r) => r.agentId);
  await report(card.id, a, "done", "ok", "review");
  await report(card.id, b, "done", "ok", "review");
  await Promise.all([runner.onTurnEnded(a, { kind: "completed" }), runner.onTurnEnded(b, { kind: "completed" })]);
  assert.equal(store.get(card.id)!.stage, "qa");
});

test("by default a card is reworked once, re-reviewed by correctness and the failing role, then stops for a person", async () => {
  const { runner, store, created, report, attach } = await setup({ useWorktree: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: "/x", title: "루프" });
  await runner.start(card.id);
  const worker = store.get(card.id)!.agentId!;
  const implement = async () => {
    await report(card.id, worker, "done", "구현");
    await runner.onTurnEnded(worker, { kind: "completed" });
  };
  const finishTeam = async (failRole: string) => {
    for (const member of store.get(card.id)!.reviewers) {
      await report(card.id, member.agentId, member.role === failRole ? "fail" : "done", member.role, "review");
      await runner.onTurnEnded(member.agentId, { kind: "completed" });
    }
  };
  await report(card.id, worker, "done", "계획");
  await runner.onTurnEnded(worker, { kind: "completed" });
  await implement();
  assert.deepEqual(store.get(card.id)!.reviewers.map((r) => r.role), ["correctness", "security", "tests"]);
  await finishTeam("tests");
  assert.equal(store.get(card.id)!.stage, "implement");
  await implement();
  assert.deepEqual(store.get(card.id)!.reviewers.map((r) => r.role), ["correctness", "tests"]);
  const sessions = created.length;
  await finishTeam("tests");
  assert.equal(store.get(card.id)!.state, "needs_human");
  assert.equal(created.length, sessions);
});

/** A folder of repositories, like a checkout root holding several projects. */
async function repoFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "todo-root-"));
  for (const name of ["api", "web"]) {
    await exec("git", ["init", "-q", "-b", "main", join(root, name)]);
    await exec("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: join(root, name) });
  }
  await mkdir(join(root, "notes"));
  return root;
}

test("a card in a folder of repositories plans there, then implements in a new session on a worktree of the named repository", async () => {
  const context = await setup();
  const root = await repoFolder();
  context.attach();
  const card = await context.runner.add({ workspaceId: "w", cwd: root, title: "하위 저장소 작업" });
  const planning = (await context.runner.start(card.id))!;
  assert.equal(planning.branch, null);
  assert.equal(context.created[0].cwd, root);
  assert.match(context.created[0].prompt, /git 저장소: api, web/);
  const planner = planning.agentId!;

  context.lastText.value = "저장소: api\n\n1. 고친다";
  await context.runner.onTurnEnded(planner, { kind: "completed" });
  const current = context.store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.branch, `todo/${card.id.slice(0, 8)}`);
  assert.equal(current.cwd, root);
  assert.equal(context.workspacesCreated[0].source.cwd, join(root, "api"));
  assert.match(current.baseRef!, /^[0-9a-f]{40}$/);
  assert.notEqual(current.agentId, planner);
  assert.equal(context.created.at(-1).agentId, current.agentId);
  assert.equal(context.created.at(-1).workspaceId, "wks-1");
  assert.match(context.created.at(-1).prompt, /<plan>[\s\S]*1\. 고친다/);
  assert.equal(context.created.at(-1).config.modeId, "auto");
  assert.equal(context.sent.length, 0);
  assert.equal(current.sessionIds.includes(planner), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(context.archived.includes(planner), true);
});

test("a plan that names no valid repository keeps the card in place on the same session", async () => {
  for (const text of ["1. 여러 저장소를 고친다", "저장소: ../밖", "저장소: notes"]) {
    const context = await setup();
    const root = await repoFolder();
    context.attach();
    const card = await context.runner.add({ workspaceId: "w", cwd: root, title: "그대로" });
    const planner = (await context.runner.start(card.id))!.agentId!;
    context.lastText.value = text;
    await context.runner.onTurnEnded(planner, { kind: "completed" });
    const current = context.store.get(card.id)!;
    assert.equal(current.stage, "implement", text);
    assert.equal(current.branch, null, text);
    assert.equal(current.agentId, planner, text);
    assert.equal(context.workspacesCreated.length, 0, text);
    assert.equal(context.sent.at(-1)?.agentId, planner, text);
  }
});

test("doc cards, cards with worktrees off, and cards already in a repository are never asked to name one", async () => {
  const root = await repoFolder();
  const doc = await setup();
  doc.attach();
  const docCard = await doc.runner.add({ workspaceId: "w", cwd: root, title: "문서", type: "doc" });
  await doc.runner.start(docCard.id);
  assert.doesNotMatch(doc.created[0].prompt, /저장소: 이름/);
  const off = await setup({ useWorktree: false });
  off.attach();
  await off.runner.start((await off.runner.add({ workspaceId: "w", cwd: root, title: "끔" })).id);
  assert.doesNotMatch(off.created[0].prompt, /저장소: 이름/);
  const repo = await setup();
  repo.attach();
  await repo.runner.start((await repo.runner.add({ workspaceId: "w", cwd: join(root, "api"), title: "저장소 안" })).id);
  assert.doesNotMatch(repo.created[0].prompt, /저장소: 이름/);
});

test("a failed link blocks the card with the reason, and a queued card starts once the first has left the folder", async () => {
  const broken = await setup();
  const root = await repoFolder();
  broken.attach();
  const card = await broken.runner.add({ workspaceId: "w", cwd: root, title: "실패" });
  const planner = (await broken.runner.start(card.id))!.agentId!;
  broken.paseo.workspaces.create = async () => {
    throw new Error("브랜치 충돌");
  };
  broken.lastText.value = "저장소: api\n계획";
  await broken.runner.onTurnEnded(planner, { kind: "completed" });
  assert.equal(broken.store.get(card.id)!.state, "blocked");
  assert.match(broken.store.get(card.id)!.attention!, /저장소 연결 실패: 브랜치 충돌/);
  assert.equal(broken.store.get(card.id)!.stage, "plan");

  const queue = await setup();
  queue.attach();
  const first = await queue.runner.add({ workspaceId: "w", cwd: root, title: "먼저" });
  const second = await queue.runner.add({ workspaceId: "w", cwd: root, title: "다음" });
  const firstPlanner = (await queue.runner.start(first.id))!.agentId!;
  assert.equal((await queue.runner.start(second.id))!.queued, true);
  queue.lastText.value = "저장소: web\n계획";
  await queue.runner.onTurnEnded(firstPlanner, { kind: "completed" });
  assert.equal(queue.store.get(second.id)!.stage, "plan");
});
