import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type Card, type CardAction, STAGE_LABELS, STAGES, addCard, cardAction, listCards } from "../shared/board";

type PluginTheme = PluginWorkspacePanelProps["theme"];
type Colors = PluginTheme["colors"];

function badge(card: Card, colors: Colors): { text: string; color: string } {
  if (card.queued) return { text: "대기열", color: colors.statusWarning };
  if (card.state === "running") return { text: card.paused ? "진행 중 · 일시정지" : "진행 중", color: colors.accent };
  if (card.state === "blocked") return { text: "차단", color: colors.statusDanger };
  if (card.state === "needs_human") return { text: "확인 필요", color: colors.statusDanger };
  if (card.stage === "done") return { text: "완료", color: colors.statusSuccess };
  if (card.paused) return { text: "일시정지", color: colors.foregroundMuted };
  return { text: card.stage === "todo" ? "" : "대기", color: colors.foregroundMuted };
}

function actionsFor(card: Card): { label: string; action: CardAction }[] {
  if (card.stage === "todo") return [{ label: "시작 → 계획", action: "start" }, { label: "삭제", action: "delete" }];
  if (card.stage === "done") return [{ label: "삭제", action: "delete" }];
  const list: { label: string; action: CardAction }[] = [];
  if (card.state === "running") list.push(card.paused ? { label: "재개", action: "resume" } : { label: "일시정지", action: "pause" });
  else {
    if (card.paused) list.push({ label: "재개", action: "resume" });
    list.push({ label: "다시 실행", action: "retry" }, { label: "다음 단계로", action: "advance" });
    if (card.stage === "review" || card.stage === "qa") list.push({ label: "구현으로 반려", action: "reject" });
    list.push({ label: "완료", action: "complete" });
  }
  list.push({ label: "삭제", action: "delete" });
  return list;
}

const makeStyles = (theme: PluginTheme, compact: boolean) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0, padding: compact ? 12 : 16, gap: 12 },
  addRow: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  primary: { backgroundColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  primaryText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
  error: { color: theme.colors.statusDanger, fontSize: 12 },
  board: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: 12, paddingBottom: 12 },
  column: { width: compact ? undefined : 260, gap: 8 },
  columnTitle: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const },
  card: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
  meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
  report: { color: theme.colors.foreground, fontSize: 12 },
  attention: { color: theme.colors.statusDanger, fontSize: 12 },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 2 },
  button: { backgroundColor: theme.colors.surface2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  buttonText: { color: theme.colors.foreground, fontSize: 12 },
  empty: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
});

export function BoardPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const cwd = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listCards);
  const add = useRpc(addCard);
  const act = useRpc(cardAction);
  const queryClient = useQueryClient();
  const queryKey = ["todo-board", workspaceId];
  const invalidate = () => queryClient.invalidateQueries({ queryKey });
  const query = useQuery({
    queryKey,
    queryFn: () => list({ workspaceId, cwd: cwd ?? "" }),
    enabled: Boolean(cwd),
    refetchInterval: 3000,
  });
  const addMutation = useMutation({ mutationFn: (title: string) => add({ workspaceId, cwd: cwd ?? "", title }), onSuccess: invalidate });
  const actMutation = useMutation({ mutationFn: (input: { cardId: string; action: CardAction }) => act(input), onSuccess: invalidate });
  const [title, setTitle] = useState("");
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    addMutation.mutate(text);
    setTitle("");
  };
  const cards = query.data?.cards ?? [];
  const error = query.error ?? addMutation.error ?? actMutation.error;

  return (
    <View style={styles.screen}>
      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={submit}
          placeholder="할 일 추가 (Enter)"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="할 일 제목"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="할 일 추가" onPress={submit} style={styles.primary}>
          <Text style={styles.primaryText}>추가</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error instanceof Error ? error.message : String(error)}</Text> : null}
      <ScrollView horizontal={!layout.compact} contentContainerStyle={styles.board}>
        {STAGES.map((stage) => {
          const column = cards.filter((card) => card.stage === stage);
          return (
            <View key={stage} style={styles.column}>
              <Text style={styles.columnTitle}>
                {STAGE_LABELS[stage]} · {column.length}
              </Text>
              {column.length === 0 ? <Text style={styles.empty}>없음</Text> : null}
              {column.map((card) => {
                const mark = badge(card, theme.colors);
                const last = card.reports.at(-1);
                return (
                  <View key={card.id} style={styles.card}>
                    <Text style={styles.title}>{card.title}</Text>
                    {card.detail ? <Text style={styles.meta}>{card.detail}</Text> : null}
                    <Text style={[styles.meta, { color: mark.color }]}>
                      {mark.text}
                      {card.retries > 0 ? ` · 반려 ${card.retries}회` : ""}
                    </Text>
                    {card.attention ? <Text style={styles.attention}>{card.attention}</Text> : null}
                    {last ? (
                      <Text style={styles.report} numberOfLines={4}>
                        [{STAGE_LABELS[last.stage]} {last.status}] {last.summary}
                      </Text>
                    ) : null}
                    <View style={styles.actions}>
                      {actionsFor(card).map(({ label, action }) => (
                        <Pressable
                          key={action}
                          accessibilityRole="button"
                          accessibilityLabel={`${card.title}: ${label}`}
                          onPress={() => actMutation.mutate({ cardId: card.id, action })}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
