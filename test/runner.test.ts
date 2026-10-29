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
    mcp: (env) => ({ type: "stdio", command: "node", args: ["mcp.mjs"], env, alwaysLoad: true }),
  });
  const report = (cardId: string, agentId: string, status: string, summary: string, stage?: string) =>
    writeFile(join(inboxDir, `${Date.now()}-${Math.random()}.json`), JSON.stringify({ kind: "report", cardId, agentId, stage, status, summary }));
  return { dir, store, runner, inboxDir, plansDir, report, attach: () => runner.attach(fake.paseo), ...fake };
}

test("start creates the worker with a chosen id and a card-bound MCP server; the plan turn may use its own mode", async () => {
  const { runner, store, created, sent, report, attach, dir, plansDir } = await setup({ planMode: "plan", useWorktree: false });
  attach();
  const card = await runner.add({ workspaceId: "w", cwd: dir, title: "기능 A" });
  let current = (await runner.start(card.id))!;
  assert.equal(current.stage, "plan");
  assert.equal(current.agentId, created[0].agentId);
  assert.equal(created[0].config.modeId, "plan");
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_AGENT_ID, created[0].agentId);
  assert.equal(created[0].config.mcpServers["todo-board"].env.TODO_STAGE, undefined);
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
  const { runner, store, created, sent, report, attach, archived } = await setup({ reviewRoles: "security,simplicity", qaRoles: "qa-run" });
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
  assert.deepEqual(current.reviewers.map((r) => r.role), ["security", "simplicity"]);
  assert.equal(created.length, 3);
  assert.equal(created[1].config.provider, "codex/codex-default");
  assert.equal(created[1].config.modeId, "full-access");
  assert.match(created[1].title, /검토 · 보안/);
  assert.match(created[2].prompt, /net: -N lines possible/);
  const [security, simplicity] = current.reviewers.map((r) => r.agentId);

  // Both report into the same inbox; each turn end only consumes its own report.
  await report(card.id, security, "done", "안전", "review");
  await report(card.id, simplicity, "fail", "L3: yagni: 추상화", "review");
  await runner.onTurnEnded(security, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "review");
  assert.equal(current.reviewers.find((r) => r.agentId === security)?.status, "done");
  assert.equal(current.reviewers.find((r) => r.agentId === simplicity)?.status, null);
  // A member that has reported is archived right away and no longer waits for completion.
  assert.deepEqual(archived, [security]);
  assert.equal(current.sessionIds.includes(security), false);
  assert.equal(current.sessionIds.includes(simplicity), true);
  await runner.onTurnEnded(simplicity, { kind: "completed" });
  current = store.get(card.id)!;
  assert.equal(current.stage, "implement");
  assert.equal(current.retries, 1);
  assert.match(sent.at(-1)!.text, /\[오버엔지니어링\]\nL3: yagni/);

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
  const { runner, store, attach } = await setup();
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
  assert.equal(isBoardToolRequest({ name: "Bash", title: "rm -rf /" }), false);
});
