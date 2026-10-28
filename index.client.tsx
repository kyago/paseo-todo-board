import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardScreen } from "./client/board-screen";
import { BoardSettingsScreen } from "./client/settings-screen";
import { addCard, clientLog } from "./shared/board";

function BoardSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ListTodo" label="투두 보드" active={currentScreen?.screenId === "board"} onPress={() => openScreen({ screenId: "board" })} />;
}

export default function contribute(client: PluginClientContext) {
  const log = (message: string) => void client.rpc(clientLog, { message }).catch(() => {});
  log("contribute start");
  const removers = [
    // Lives in the sidebar header next to 기록·검색·일정; the screen spans every workspace on the host.
    client.addScreen({ id: "board", title: "투두 보드", Component: BoardScreen }),
    client.addSidebarHeaderItem({ id: "board", title: "투두 보드", Component: BoardSidebarItem }),
    client.addCommandCenterItem({
      id: "open-board",
      title: "투두 보드 열기",
      icon: "ListTodo",
      keywords: ["todo", "board", "kanban", "투두", "할 일", "보드"],
      context: "workspace",
      onSelect({ workspace, openScreen }) {
        openScreen({ screenId: "board", params: { workspaceId: workspace.id } });
      },
    }),
    // `/todo 제목` adds a card without prompting the agent; `/todo` alone opens the board on this workspace.
    client.addSlashCommand({
      name: "todo",
      description: "투두 보드에 할 일 추가 (비우면 보드 열기)",
      argumentHint: "[할 일 제목]",
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openScreen }) {
        if (args.trim()) await rpc(addCard, { workspaceId: workspace.id, cwd: workspace.directory, title: args.trim() });
        openScreen({ screenId: "board", params: { workspaceId: workspace.id } });
      },
    }),
    client.addSettingsScreen({ id: "board", title: "Options", icon: "Settings", Component: BoardSettingsScreen }),
  ];
  log("contribute done: screen, sidebar item, command, slash, settings registered");
  return () => {
    for (const remove of removers) void remove();
  };
}
