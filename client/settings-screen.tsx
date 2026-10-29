import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ROLES } from "../shared/roles";
import { type BoardSettingsValues, boardSettings } from "../shared/settings";

const roleList = (stage: "review" | "qa") => ROLES.filter((role) => role.stage === stage).map((role) => `${role.id}(${role.label})`).join(", ");

export function BoardSettingsScreen() {
  const settings = useSettings(boardSettings);
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="투두 보드">
        <SettingsCard>
          <SettingsRow label="설정" hint={settings.status === "loading" ? "불러오는 중…" : settings.error} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, revision } = settings;
  const save = (patch: Partial<BoardSettingsValues>) => void settings.save({ ...values, ...patch }, revision);
  return (
    <SettingsSection title="투두 보드">
      <SettingsCard>
        <SettingsSwitch
          label="자동 진행"
          hint="끄면 보고만 기록하고 단계 이동은 버튼으로만 합니다."
          error={settings.saveError ?? undefined}
          value={values.autoAdvance}
          onValueChange={(autoAdvance) => save({ autoAdvance })}
        />
        <SettingsSwitch
          label="모든 새 세션에 todo_add 도구 주입"
          hint="세션에서 '할 일로 남겨 줘'라고 하면 에이전트가 보드에 카드를 추가할 수 있습니다. 플러그인 설치 뒤 새로 만든 세션에만 적용됩니다."
          value={values.injectTools}
          onValueChange={(injectTools) => save({ injectTools })}
        />
        <SettingsInput
          label="반려 재시도 상한"
          hint="검토·품질 검증이 이 횟수를 넘겨 반려하면 '확인 필요'로 멈춥니다. 0~5."
          initialValue={String(values.maxRetries)}
          onChangeText={(text) => {
            const value = Number.parseInt(text, 10);
            if (Number.isInteger(value) && value >= 0 && value <= 5 && value !== values.maxRetries) save({ maxRetries: value });
          }}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="작업 세션 (계획·구현)"
          hint="provider 또는 provider/model. 예: claude, claude/claude-opus-5-5"
          initialValue={values.workerProvider}
          onChangeText={(text) => text.trim() && text.trim() !== values.workerProvider && save({ workerProvider: text.trim() })}
        />
        <SettingsInput
          label="작업 세션 권한 모드"
          hint="claude: auto, acceptEdits, bypassPermissions / codex: auto, full-access. 비우면 provider 기본값."
          initialValue={values.workerMode}
          onChangeText={(text) => text.trim() !== values.workerMode && save({ workerMode: text.trim() })}
        />
        <SettingsInput
          label="계획 단계 모드"
          hint="계획 턴에만 쓰는 모드. 비우면 작업 세션 모드와 같음. claude의 plan은 파일을 못 쓰므로 보고 내용을 보드가 계획 파일로 저장합니다."
          initialValue={values.planMode}
          placeholder="(작업 세션 모드와 같음)"
          onChangeText={(text) => text.trim() !== values.planMode && save({ planMode: text.trim() })}
        />
        <SettingsInput
          label="검토 세션 (검토·품질 검증)"
          hint="구현과 다른 모델을 권장합니다. 예: codex, codex/gpt-5.5"
          initialValue={values.reviewerProvider}
          onChangeText={(text) => text.trim() && text.trim() !== values.reviewerProvider && save({ reviewerProvider: text.trim() })}
        />
        <SettingsInput
          label="검토 세션 권한 모드"
          hint="codex: auto, auto-review, full-access(기본, 보고 도구 승인 프롬프트 없음) / claude: auto, bypassPermissions."
          initialValue={values.reviewerMode}
          onChangeText={(text) => text.trim() !== values.reviewerMode && save({ reviewerMode: text.trim() })}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="검토 팀 역할"
          hint={`쉼표로 구분. 비우면 전원. 가능: ${roleList("review")}`}
          initialValue={values.reviewRoles}
          onChangeText={(text) => text.trim() !== values.reviewRoles && save({ reviewRoles: text.trim() })}
        />
        <SettingsInput
          label="품질 검증 팀 역할"
          hint={`쉼표로 구분. 비우면 전원. 가능: ${roleList("qa")}`}
          initialValue={values.qaRoles}
          onChangeText={(text) => text.trim() !== values.qaRoles && save({ qaRoles: text.trim() })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
