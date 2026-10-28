import { type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type Card, type CardAction, addCard, cardAction, listAllCards } from "../shared/board";
import { BoardView, folderName } from "./board-view";

interface WorkspaceChoice {
  id: string;
  cwd: string;
  name: string;
}

const ALL = "__all__";

/** The sidebar screen: every card on this host, filtered by a workspace chip; "전체" shows them all with their folder. */
export function BoardScreen({ theme, layout, params }: PluginScreenProps) {
  const paseo = usePaseo();
  const listAll = useRpc(listAllCards);
  const add = useRpc(addCard);
  const act = useRpc(cardAction);
  const queryClient = useQueryClient();
  const preselected = typeof params.workspaceId === "string" ? params.workspaceId : null;
  const [selected, setSelected] = useState<string>(preselected ?? ALL);

  const workspaces = useQuery({
    queryKey: ["todo-board", "workspaces"],
    queryFn: async (): Promise<WorkspaceChoice[]> => {
      const { entries } = await paseo.workspaces.list();
      return entries
        .filter((workspace) => !workspace.archivingAt)
        .map((workspace) => ({ id: workspace.id, cwd: workspace.workspaceDirectory ?? workspace.projectRootPath, name: workspace.title ?? workspace.name }));
    },
    refetchInterval: 15000,
  });
  const cardsQuery = useQuery({ queryKey: ["todo-board", "all"], queryFn: () => listAll({}), refetchInterval: 3000 });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["todo-board", "all"] });
  const addMutation = useMutation({ mutationFn: (input: { workspaceId: string; cwd: string; title: string }) => add(input), onSuccess: invalidate });
  const actMutation = useMutation({ mutationFn: (input: { cardId: string; action: CardAction }) => act(input), onSuccess: invalidate });

  const choices = workspaces.data ?? [];
  const current = choices.find((workspace) => workspace.id === selected) ?? null;
  const cards: Card[] = useMemo(() => {
    const all = cardsQuery.data?.cards ?? [];
    if (!current) return all;
    return all.filter((card) => card.workspaceId === current.id || card.cwd === current.cwd);
  }, [cardsQuery.data, current]);

  const styles = useMemo(
    () => ({
      chips: { flexDirection: "row" as const, gap: 6, paddingBottom: 4 },
      chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border },
      chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
    }),
    [theme],
  );

  const chip = (id: string, label: string) => {
    const active = selected === id;
    return (
      <Pressable key={id} accessibilityRole="button" accessibilityLabel={`워크스페이스 ${label}`} onPress={() => setSelected(id)} style={[styles.chip, active && styles.chipActive]}>
        <Text style={active ? styles.chipTextActive : styles.chipText}>{label}</Text>
      </Pressable>
    );
  };

  const header = (
    <View>
      <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
        {chip(ALL, `전체 ${cardsQuery.data?.cards.length ?? 0}`)}
        {choices.map((workspace) => chip(workspace.id, workspace.name || folderName(workspace.cwd)))}
      </ScrollView>
    </View>
  );

  return (
    <BoardView
      theme={theme}
      compact={layout.compact}
      cards={cards}
      header={header}
      showFolder={!current}
      error={cardsQuery.error ?? workspaces.error ?? addMutation.error ?? actMutation.error}
      onAdd={current ? (title) => addMutation.mutate({ workspaceId: current.id, cwd: current.cwd, title }) : null}
      onAction={(cardId, action) => actMutation.mutate({ cardId, action })}
    />
  );
}
