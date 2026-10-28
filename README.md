# paseo-todo-board

Paseo 플러그인. 워크스페이스별 칸반 보드(할 일 → 계획 → 구현 → 검토 → 품질 검증 → 완료)에서 카드를 '계획'으로 옮기면, 이후 단계를 AI 세션이 차례로 진행하고 단계마다 보고를 남긴다. 자세한 동작은 [OVERVIEW.md](OVERVIEW.md).

## 설치

```bash
paseo plugin install github:kyago/paseo-todo-board
# 또는 로컬 체크아웃
paseo plugin install /absolute/path/to/paseo-todo-board
```

Paseo 0.13.0 이상. 설치 후 Settings → Plugins → 투두 보드 → Options에서 작업·검토 세션의 provider와 권한 모드를 고른다.

## 개발

```bash
npm install
npm run typecheck
npm test
paseo plugin reload todo-board
```

- `shared/` Zod 계약·프롬프트, `server/` 상태기계·저장소·MCP 서버·러너, `client/` 사이드바 화면과 설정.
- 세션이 쓰는 MCP 도구: `todo_add`, `todo_start`, `todo_report`. 보드 상태는 `~/.paseo/plugin-data/todo-board/`.
