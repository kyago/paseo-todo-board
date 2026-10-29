import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type Card, type CardAction, type ReportStatus, STAGE_LABELS, STAGES } from "../shared/board";

export type PluginTheme = PluginScreenProps["theme"];
type Colors = PluginTheme["colors"];
export const folderName = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

function badge(card: Card, colors: Colors): { text: string; color: string } {
  if (card.queued) return { text: "대기열", color: colors.statusWarning };
  if (card.state === "running") return { text: card.paused ? "진행 중 · 일시정지" : "진행 중", color: colors.accent };
  if (card.state === "blocked") return { text: "차단", color: colors.statusDanger };
  if (card.state === "needs_human") return { text: "확인 필요", color: colors.statusDanger };
  if (card.stage === "done") return { text: "완료", color: colors.statusSuccess };
  if (card.paused) return { text: "일시정지", color: colors.foregroundMuted };
  return { text: card.stage === "todo" ? "" : "대기", color: colors.foregroundMuted };
}

const statusColor = (status: ReportStatus | null, colors: Colors) =>
  status === "done" ? colors.statusSuccess : status === "fail" ? colors.statusDanger : status === "blocked" ? colors.statusWarning : colors.foregroundMuted;
const statusText = (status: ReportStatus | null) => (status === "done" ? "통과" : status === "fail" ? "반려" : status === "blocked" ? "중단" : "진행 중");

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
  // A rule between stages: vertical beside each column on wide layouts, horizontal between stacked sections on compact ones.
  divider: compact ? { height: 1, backgroundColor: theme.colors.border, marginVertical: 4 } : { width: 1, backgroundColor: theme.colors.border, alignSelf: "stretch" as const },
  columnTitle: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const },
  card: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
  meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
  report: { color: theme.colors.foreground, fontSize: 12 },
  attention: { color: theme.colors.statusDanger, fontSize: 12 },
  link: { color: theme.colors.accent, fontSize: 12, textDecorationLine: "underline" as const },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 2 },
  button: { backgroundColor: theme.colors.surface2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  buttonText: { color: theme.colors.foreground, fontSize: 12 },
  empty: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
});

export interface BoardViewProps {
  theme: PluginTheme;
  compact: boolean;
  cards: Card[];
  /** Null disables the add row (no workspace chosen). */
  onAdd: ((title: string) => void) | null;
  onAction: (cardId: string, action: CardAction) => void;
  /** Show each card's folder; for the cross-workspace view. */
  showFolder?: boolean;
  error?: unknown;
  header?: React.ReactNode;
}

export function BoardView({ theme, compact, cards, onAdd, onAction, showFolder, error, header }: BoardViewProps) {
  const [title, setTitle] = useState("");
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);

  const submit = () => {
    const text = title.trim();
    if (!text || !onAdd) return;
    onAdd(text);
    setTitle("");
  };

  return (
    <View style={styles.screen}>
      {header}
      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={submit}
          editable={Boolean(onAdd)}
          placeholder={onAdd ? "할 일 추가 (Enter)" : "워크스페이스를 고르면 추가할 수 있습니다"}
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="할 일 제목"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="할 일 추가" onPress={submit} disabled={!onAdd} style={[styles.primary, !onAdd && { opacity: 0.5 }]}>
          <Text style={styles.primaryText}>추가</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error instanceof Error ? error.message : String(error)}</Text> : null}
      <ScrollView horizontal={!compact} contentContainerStyle={styles.board}>
        {STAGES.map((stage, index) => {
          const column = cards.filter((card) => card.stage === stage);
          return [
            index > 0 ? <View key={`${stage}-divider`} style={styles.divider} /> : null,
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
                    {showFolder ? <Text style={styles.meta}>📁 {folderName(card.cwd)}</Text> : null}
                    {card.detail ? <Text style={styles.meta}>{card.detail}</Text> : null}
                    <Text style={[styles.meta, { color: mark.color }]}>
                      {mark.text}
                      {card.retries > 0 ? ` · 반려 ${card.retries}회` : ""}
                    </Text>
                    {card.branch ? <Text style={styles.meta}>⎇ {card.branch}</Text> : null}
                    {card.prUrl ? (
                      <ExternalLink href={card.prUrl} accessibilityLabel={`${card.title} PR 열기`}>
                        <Text style={styles.link}>PR 열기</Text>
                      </ExternalLink>
                    ) : null}
                    {card.attention ? <Text style={styles.attention}>{card.attention}</Text> : null}
                    {card.reviewers.map((reviewer) => (
                      <Text key={reviewer.agentId} style={styles.meta}>
                        {reviewer.label}: <Text style={{ color: statusColor(reviewer.status, theme.colors) }}>{statusText(reviewer.status)}</Text>
                      </Text>
                    ))}
                    {last ? (
                      <Text style={styles.report} numberOfLines={4}>
                        [{STAGE_LABELS[last.stage]}{last.role ? ` · ${last.role}` : ""} {statusText(last.status)}] {last.summary}
                      </Text>
                    ) : null}
                    <View style={styles.actions}>
                      {actionsFor(card).map(({ label, action }) => (
                        <Pressable
                          key={action}
                          accessibilityRole="button"
                          accessibilityLabel={`${card.title}: ${label}`}
                          onPress={() => onAction(card.id, action)}
                          style={styles.button}
                        >
                          <Text style={styles.buttonText}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>,
          ];
        })}
      </ScrollView>
    </View>
  );
}
