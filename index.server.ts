import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installMcpScript, mcpServerConfig, resolveNode } from "./server/mcp.ts";
import { boardFile, inboxDir, mcpScriptFile } from "./server/paths.ts";
import { Runner } from "./server/runner.ts";
import { BoardStore } from "./server/store.ts";
import { addCard, cardAction, clientLog, listAllCards, listCards } from "./shared/board.ts";
import { type BoardSettingsValues, boardSettings } from "./shared/settings.ts";

export default function contribute(server: PluginServerContext) {
  const store = new BoardStore(boardFile());
  let values: BoardSettingsValues = boardSettings.schema.parse({});
  const settings = server.registerSettings(boardSettings);
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") values = state.values;
  };
  void settings.read().then(applySettings);
  const stopSettings = settings.subscribe(applySettings);

  let node = "node";
  const inbox = inboxDir();
  const script = mcpScriptFile();
  const mcp = (env: Record<string, string>) => mcpServerConfig(node, script, { TODO_INBOX: inbox, ...env });
  const runner = new Runner({ store, inboxDir: inbox, settings: () => values, mcp });

  let watcher: ReturnType<typeof watch> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const ready = (async () => {
    await store.load();
    await mkdir(inbox, { recursive: true });
    await installMcpScript(script);
    node = await resolveNode();
    await runner.processInbox();
    // `todo_add` from any session lands here; reports stay until that session's turn ends.
    watcher = watch(inbox, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void runner.processInbox().catch((error) => console.error("[todo-board] inbox", error)), 300);
    });
    console.log(`[todo-board] ready: ${store.all().length} cards, mcp ${node} ${script}`);
  })().catch((error) => console.error("[todo-board] startup failed", error));

  server.handle(clientLog, ({ message }) => {
    console.log(`[client] ${message}`);
    return {};
  });
  server.handle(listCards, async ({ workspaceId, cwd }, { paseo }) => {
    await ready;
    runner.attach(paseo);
    return { cards: store.list(workspaceId, cwd) };
  });
  server.handle(listAllCards, async (_input, { paseo }) => {
    await ready;
    runner.attach(paseo);
    return { cards: store.all() };
  });
  server.handle(addCard, async ({ workspaceId, cwd, title, detail }, { paseo }) => {
    await ready;
    runner.attach(paseo);
    return { card: await runner.add({ workspaceId, cwd, title, detail }) };
  });
  server.handle(cardAction, async ({ cardId, action }, { paseo }) => {
    await ready;
    runner.attach(paseo);
    return { card: await runner.action(cardId, action) };
  });

  const removers = [
    // Every new session gets todo_add; sessions the board creates already carry their own entry.
    server.before("agent.create", async ({ request }, { paseo }) => {
      await ready;
      runner.attach(paseo);
      if (!values.injectTools || request.config.mcpServers?.["todo-board"]) return;
      return { ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, "todo-board": mcp({ TODO_CWD: request.config.cwd }) } } };
    }),
    // The earliest moments a daemon session reaches the plugin; a `todo_start` before any of them waits in the queue.
    server.on("agent.turn_started", async (_event, { paseo }) => {
      await ready;
      runner.attach(paseo);
    }),
    server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
      await ready;
      runner.attach(paseo);
      await runner.onTurnEnded(agent.id, outcome);
    }),
    server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
      await ready;
      runner.attach(paseo);
      const deny = runner.permissionDecision(agent.id, request);
      if (deny) {
        await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "deny", message: deny } });
        return;
      }
      await runner.onPermission(agent.id, true);
    }),
    server.on("agent.permission_resolved", async ({ agent }, { paseo }) => {
      await ready;
      runner.attach(paseo);
      await runner.onPermission(agent.id, false);
    }),
  ];

  return () => {
    stopSettings();
    for (const remove of removers) remove();
    watcher?.close();
    if (timer) clearTimeout(timer);
  };
}
