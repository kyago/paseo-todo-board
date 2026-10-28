import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardPanel } from "./client/board-panel";
import { BoardSettingsScreen } from "./client/settings-screen";
import { addCard, clientLog } from "./shared/board";

export default function contribute(client: PluginClientContext) {
  const log = (message: string) => void client.rpc(clientLog, { message }).catch(() => {});
  log("contribute start");
  const removers = [
    client.addWorkspacePanel({ id: "board", title: "투두 보드", icon: "ListTodo", locations: ["workspace", "explorer"], Component: BoardPanel }),
    client.addCommandCenterItem({
      id: "open-board",
      title: "투두 보드 열기",
      icon: "ListTodo",
      keywords: ["todo", "board", "kanban", "투두", "할 일", "보드"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("board");
      },
    }),
    // `/todo 제목` adds a card without prompting the agent; `/todo` alone opens the board.
    client.addSlashCommand({
      name: "todo",
      description: "투두 보드에 할 일 추가 (비우면 보드 열기)",
      argumentHint: "[할 일 제목]",
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openPanel }) {
        if (args.trim()) await rpc(addCard, { workspaceId: workspace.id, cwd: workspace.directory, title: args.trim() });
        openPanel("board");
      },
    }),
    client.addSettingsScreen({ id: "board", title: "Options", icon: "Settings", Component: BoardSettingsScreen }),
  ];
  log("contribute done: panel, command, slash, settings registered");
  return () => {
    for (const remove of removers) void remove();
  };
}
