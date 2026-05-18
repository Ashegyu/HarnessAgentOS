# Implementation Plan: Agent별 상세 설정

> 사용자가 GUI에서 Agent별로 페르소나·MCP 서버·Skill 소스·모델 파라미터·CLI 환경·권한 정책을 설정할 수 있도록 하는 설계.

---

## 0. 개요

HarnessAgentOS의 글로벌 단일 `AgentSettings`와 평면 `WorkerProfile[]`을, **에이전트 단위로 모델·MCP·Skill·권한·CLI 환경·페르소나를 묶은 `AgentProfile`**로 일반화한다. 모든 변경은 9-layer IPC 패턴을 따르고 기존 `services/*`의 storage import 금지 규칙을 유지하며, 단계적 머지가 가능하도록 6개 phase로 분해한다.

### 핵심 목표
1. 사용자가 GUI에서 에이전트별 페르소나·모델 파라미터·MCP 서버·Skill 소스·도구/액션 권한·CLI 경로를 편집할 수 있다.
2. 기존 단일 `agent` 설정과 `orchestration.workerProfiles[]`을 무중단 마이그레이션한다.
3. 자격증명은 Electron `safeStorage` (EncryptedString) 로만 저장하고, 평문 JSON에는 절대 남기지 않는다.
4. CLI 호출(`ModelCliAdapter`)에 MCP config 파일 인자와 skill 디렉터리 목록을 spawn 시점에 합성하여 전달한다.

### 비목표 (이번 설계 범위 밖)
- MCP 서버 자체의 implementation (우리는 외부 MCP 프로세스의 spawner/proxy일 뿐).
- Claude/Codex CLI 외 신규 provider 추가.
- 에이전트별 quota·rate-limit·cost trace UI.

---

## 1. 검증 필요 사항 (Phase 0 prerequisite)

| ID | 검증 대상 | 검증 방법 | 영향 phase |
|----|-----------|----------|------------|
| V1 | Claude Code CLI의 MCP config 인자 형식 | 현재 구현은 `claude --mcp-config <path> --strict-mcp-config` 경로로 제한 | Phase 3, 4 |
| V2 | Codex CLI의 MCP config 인자 형식 | 미검증/보류. `codex exec`에는 MCP config path를 전달하지 않음 | Phase 3, 4 |
| V3 | Claude CLI의 system prompt 전달 매커니즘이 `--system-prompt`로 충분한지 | 코드 grep 및 CLI 실측 | Phase 4 |
| V4 | `safeStorage.isEncryptionAvailable()`가 Windows에서 DPAPI 기반으로 동작 | 실측, fallback 경로 필요 | Phase 2 |
| V5 | persona/시스템프롬프트 추가 시 토큰 한도 | CLI 실측 | Phase 4 |

---

## 2. 요구사항 정리

| # | 요구 | 측정 가능 acceptance |
|---|------|---------------------|
| R1 | 역할/페르소나 | profile 별 `systemPromptPersona` 문자열, prompt builder가 prefix로 주입 |
| R2 | MCP 서버 CRUD | UI에서 add/edit/delete/toggle, health-check 결과 표시, 재시작 없이 다음 invocation부터 적용 |
| R3 | Skill 등록 | 임의 디렉터리 등록, trusted 토글, skill 단위 enabled/disabled, SKILL.md 위저드 |
| R4 | 모델 파라미터 | profile 별 model/temperature/max_tokens/timeout/contextDepth/system prompt prefix·suffix/tool allow·deny |
| R5 | CLI 경로/환경 | profile 별 CLI 실행 파일 경로 override, 환경변수 secret 주입 |
| R6 | 권한 정책 | profile 별 actionType 자동승인 화이트리스트 (글로벌보다 우선) |
| R7 | Agent Profile | 위 모든 설정을 묶은 단일 row. `WorkerProfile` 일반화 |

---

## 3. 아키텍처 변경 요약

```
packages/core
  types/
    agent-profile.ts  ← NEW (AgentProfile, AgentPermissions)
    mcp.ts            ← NEW (McpServerConfig, McpTransport)
    skill-source.ts   ← NEW (SkillSource)
    settings.ts       ← 확장 (HarnessSettings.activeAgentProfileId)
  ipc-channels.ts     ← 4개 namespace 추가
  api.ts              ← window.harness.{agents,mcp,skillSource,secret}

packages/storage
  repositories/agent-profile-repository.ts ← NEW
  repositories/mcp-server-repository.ts    ← NEW
  repositories/skill-source-repository.ts  ← NEW
  services/secret-vault.ts                 ← NEW (safeStorage)
  migrations.ts ← v7~v10 추가

packages/agent
  mcp-config-builder.ts ← NEW (profile→CLI config 합성)
  model-cli-adapter.ts  ← spawn 인자 확장
  agent-prompt-builder.ts ← persona prefix 주입

packages/skillify-adapter
  skill-source-resolver.ts ← NEW (registered sources 조회)

apps/desktop/electron
  ipc/agents-ipc.ts      ← NEW
  ipc/mcp-ipc.ts         ← NEW
  ipc/skill-source-ipc.ts ← NEW
  ipc/secret-ipc.ts      ← NEW

apps/desktop/src/screens/settings  (탭 구조 신설)
  SettingsModal.tsx     ← refactor: 탭 컨테이너
  tabs/GeneralTab.tsx
  tabs/AgentProfilesTab.tsx
  tabs/McpServersTab.tsx
  tabs/SkillSourcesTab.tsx
  tabs/PermissionsTab.tsx
```

---

## 4. 타입 정의 초안

### 4.1 `packages/core/src/types/agent-profile.ts`

```ts
import type { AgentProvider } from "./settings.ts";
import type { WorkerRole } from "./orchestration.ts";

export type ActionType =
  | "file_write" | "shell" | "dependency_install"
  | "git_commit" | "network" | "skill_script" | "orchestration_plan";

export interface AgentPermissions {
  /** 자동승인되는 action type 화이트리스트. 글로벌 autoApprove보다 우선. */
  autoApproveActions: readonly ActionType[];
  /** 금지 action type. 자동승인뿐 아니라 일반 호출도 차단. */
  blockedActions: readonly ActionType[];
  /** Skill ID 화이트리스트. 빈 배열 = 모든 enabled skill 허용. */
  allowedSkillIds: readonly string[];
  /** MCP tool 이름 패턴(글롭) 화이트리스트. 빈 배열 = 모두 허용. */
  toolAllowlist: readonly string[];
  /** MCP tool 이름 패턴 거부 목록. allowlist보다 우선. */
  toolDenylist: readonly string[];
}

export interface AgentCliEnv {
  /** CLI 실행 파일 절대 경로 override. 빈 문자열 = $PATH 검색. */
  cliPathOverride: string;
  /** 환경변수(평문). 비밀은 envSecretRefs로. */
  env: Readonly<Record<string, string>>;
  /** 환경변수명 → SecretVault key 매핑. spawn 시점에 복호화 주입. */
  envSecretRefs: Readonly<Record<string, string>>;
}

export interface AgentModelTuning {
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  stallTimeoutMs: number;
  contextDepth: number;
  systemPromptPrefix: string;
  systemPromptSuffix: string;
}

export interface AgentProfile {
  id: string;                // 'ap_' + nanoid(12)
  name: string;
  description: string;
  provider: AgentProvider;
  role: WorkerRole;
  persona: string;           // 자연어 역할 설명 (R1)
  tuning: AgentModelTuning;
  cli: AgentCliEnv;
  permissions: AgentPermissions;
  mcpServerIds: readonly string[];
  skillSourceIds: readonly string[];
  isDefault: boolean;        // 정확히 하나만 true
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_AGENT_PERMISSIONS: Readonly<AgentPermissions> = Object.freeze({
  autoApproveActions: [],
  blockedActions: [],
  allowedSkillIds: [],
  toolAllowlist: [],
  toolDenylist: [],
});
```

### 4.2 `packages/core/src/types/mcp.ts`

```ts
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;          // stdio
  args?: readonly string[];
  url?: string;              // http/sse
  env: Readonly<Record<string, string>>;
  envSecretRefs: Readonly<Record<string, string>>;
  scope: "global" | "per-agent";
  enabled: boolean;
  lastHealth?: {
    okAt?: string;
    error?: string;
    checkedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

### 4.3 `packages/core/src/types/skill-source.ts`

```ts
export type SkillSourceOrigin = "project" | "user" | "custom";

export interface SkillSource {
  id: string;
  name: string;
  origin: SkillSourceOrigin;
  rootDir: string;
  trusted: boolean;
  enabled: boolean;
  registeredInPathPolicy: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 4.4 `HarnessSettings` 확장

```ts
export interface HarnessSettings {
  agent: AgentSettings;                   // 유지 (legacy fallback)
  orchestration: OrchestrationSettings;   // 유지 (workerProfiles는 deprecated)
  approval: ApprovalSettings;             // 유지
  activeAgentProfileId?: string;          // NEW
}
```

> **분리 원칙**: `AgentProfile[]`, `McpServerConfig[]`, `SkillSource[]`는 **별도 테이블**. `HarnessSettings` JSON 안에 넣지 않는다.

---

## 5. Phase별 단계

### Phase 1 — 타입 모델 & core 패키지 (단독 머지 가능)

| # | 작업 | 파일 | 9-layer |
|---|------|------|---------|
| 1.1 | `AgentProfile` 등 정의 | `packages/core/src/types/agent-profile.ts` (NEW) | 1 |
| 1.2 | `McpServerConfig` 정의 | `packages/core/src/types/mcp.ts` (NEW) | 1 |
| 1.3 | `SkillSource` 정의 | `packages/core/src/types/skill-source.ts` (NEW) | 1 |
| 1.4 | `HarnessSettings`에 `activeAgentProfileId` 추가 | `packages/core/src/types/settings.ts` | 1 |
| 1.5 | 4개 namespace 추가 | `packages/core/src/ipc-channels.ts` | 1 |
| 1.6 | window API 타입 | `packages/core/src/api.ts` | 2 |
| 1.7 | barrel export | `packages/core/src/index.ts` | 1 |
| 1.8 | 타입 가드/validator | `packages/core/src/validators/*` | 1 |
| 1.9 | 단위 테스트 | `packages/core/src/types/__tests__/*.test.mjs` | 9 |

**Risk**: Low. **Est**: 0.5d.

---

### Phase 2 — 저장소·마이그레이션·SecretVault

| # | 작업 | 파일 |
|---|------|------|
| 2.1 | schema v7~v10 추가 (`agent_profiles`, `mcp_servers`, `skill_sources`, `secrets`) | `packages/storage/src/schema.ts` |
| 2.2 | `applyMigrations` idempotent step | `packages/storage/src/migrations.ts` |
| 2.3 | `AgentProfileRepository` | `packages/storage/src/repositories/agent-profile-repository.ts` (NEW) |
| 2.4 | `McpServerRepository` | NEW |
| 2.5 | `SkillSourceRepository` | NEW |
| 2.6 | `SecretVaultService` — Electron `safeStorage` 래퍼 | `packages/storage/src/services/secret-vault.ts` (NEW) |
| 2.7 | `LocalStateService`에 노출 | `packages/storage/src/services/local-state-service.ts` |
| 2.8 | `WorkerProfile` → `AgentProfile` 변환 유틸 | `packages/storage/src/services/profile-migrator.ts` (NEW) |
| 2.9 | 마이그레이션 dry-run 테스트 | `__tests__/migrations.test.mjs` |
| 2.10 | safeStorage 가용성 fallback (write 거부 + UI 경고) | secret-vault |

**스키마 시안**

```sql
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL CHECK(provider IN ('auto','claude','codex')),
  role TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  tuning_json TEXT NOT NULL,
  cli_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  mcp_server_ids_json TEXT NOT NULL DEFAULT '[]',
  skill_source_ids_json TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
  ON agent_profiles(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL CHECK(transport IN ('stdio','http','sse')),
  command TEXT, args_json TEXT, url TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  env_secret_refs_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL CHECK(scope IN ('global','per-agent')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('project','user','custom')),
  root_dir TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  registered_in_path_policy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(root_dir)
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

**Risk**: Medium. **Est**: 1.5d.

---

### Phase 3 — IPC 핸들러

**IPC 채널 시안** (도메인 당 5~7개로 제한)

```ts
agents: {
  list: "agents:list",
  get: "agents:get",
  create: "agents:create",
  update: "agents:update",
  delete: "agents:delete",
  setDefault: "agents:setDefault",
  setActive: "agents:setActive",
},
mcp: {
  list: "mcp:list",
  upsert: "mcp:upsert",
  delete: "mcp:delete",
  toggle: "mcp:toggle",
  healthCheck: "mcp:healthCheck",
},
skillSource: {
  list: "skillSource:list",
  add: "skillSource:add",
  update: "skillSource:update",
  remove: "skillSource:remove",
  refresh: "skillSource:refresh",
},
secret: {
  write: "secret:write",
  clear: "secret:clear",
  listKeys: "secret:listKeys",  // 값은 절대 반환하지 않음
},
```

| # | 작업 | 파일 |
|---|------|------|
| 3.1 | `agents-ipc.ts` | `apps/desktop/electron/ipc/agents-ipc.ts` (NEW) |
| 3.2 | `mcp-ipc.ts` | NEW |
| 3.3 | `skill-source-ipc.ts` | NEW |
| 3.4 | `secret-ipc.ts` | NEW |
| 3.5 | preload bridge | `apps/desktop/electron/preload.ts` |
| 3.6 | main.ts wiring | `apps/desktop/electron/ipc/index.ts`, `main.ts` |
| 3.7 | Path policy: 사용자 등록 skill root를 sourceDir 화이트리스트에 등록 | `packages/core/src/security/path-policy.ts` |
| 3.8 | IPC 통합 테스트 | `__tests__/*` |

**Risk**: Medium. **Est**: 1.5d.

---

### Phase 4 — 서비스 wiring & CLI 통합

| # | 작업 | 파일 |
|---|------|------|
| 4.1 | `McpConfigBuilder` — profile.mcpServerIds → temp JSON 파일 생성, env decrypt | `packages/agent/src/mcp-config-builder.ts` (NEW) |
| 4.2 | `ModelCliRequest` 시그니처 확장: `mcpConfigPath?`, `profileId?` | `packages/agent/src/model-cli-types.ts` |
| 4.3 | `DefaultModelCliAdapter` — Claude는 `--mcp-config`/`--strict-mcp-config`, Codex는 MCP 인자 생략 | `packages/agent/src/model-cli-adapter.ts` |
| 4.4 | `AgentPromptBuilder` — persona prefix/suffix 주입 | `packages/agent/src/agent-prompt-builder.ts` |
| 4.5 | `AgentPlanningService` — profile 해상 로직 (active → role → legacy) | `packages/agent/src/agent-planning-service.ts` |
| 4.6 | `CapabilityRegistry.refresh` — 등록된 SkillSource[] 기반 동적 refresh | `packages/skillify-adapter/src/capability-service.ts`, `skill-loader.ts` |
| 4.7 | `OrchestrationService.workerProfiles` → AgentProfile resolver (legacy alias) | `packages/orchestration/src/*` |
| 4.8 | 자동승인 정책: profile.permissions.autoApproveActions가 글로벌 autoApprove보다 우선 | `ApprovalPanel.tsx` 등 |
| 4.9 | MCP temp config 파일 cleanup (`finally`에서 unlink) | mcp-config-builder |
| 4.10 | 통합 테스트: FakeModelCliAdapter로 spawn args assertion | `__tests__/*.test.mjs` |

**MCP 통합 전략 (현재 구현 기준)**

1. `AgentPlanningService.invoke()`에서 활성 profile 결정.
2. main process의 `prepareMcpInvocation({ profileId, provider })`가 provider를 먼저 확인한다.
   - `provider !== "claude"`이면 `mcpConfigPath: null`을 반환한다. Codex MCP config 전달은 V2 검증 전까지 보류다.
3. Claude provider일 때만 `McpConfigBuilder.build({ profileId })`에 해당하는 합성을 수행한다:
   - enabled global MCP와 profile.mcpServerIds 에 해당하는 enabled per-agent `McpServerConfig[]` 조회
   - 각 server의 `envSecretRefs`를 SecretVault로 복호화하여 `env` 머지
   - Claude CLI 포맷:
      ```json
      { "mcpServers": {
          "<name>": { "command": "...", "args": [...], "env": {...} } } }
      ```
4. `userData/mcp-tmp/mcp-<uuid>.json`에 600 permission으로 write.
5. `ModelCliRequest`에 `mcpConfigPath` 첨부 → Claude 인자에 `--mcp-config <path> --strict-mcp-config`를 합성.
6. invocation 종료 시(`finally`) temp 파일 unlink. SecretVault는 디스크에 평문을 절대 남기지 않음.

**비채택 대안**: user-level config(`~/.claude.json` 등)를 atomic write+restore하는 방식은 동시 invocation·crash 시 사용자 글로벌 설정 손상 위험이 있어 현재 구현 경계에 넣지 않는다.

**Risk**: High. **Est**: 2.5d.

---

### Phase 5 — UI 골격 (탭 구조)

**역할 분리 원칙**
- **SettingsModal** (lazy mount): 편집. Profile/MCP/Skill source/Permissions의 CRUD.
- **AgentsPanel** (workbench 메인): 모니터링·실행. 활성 profile 표시, queue 상태, 실행 결과. CRUD UI 제거 → SettingsModal 링크 버튼.

| # | 작업 | 파일 |
|---|------|------|
| 5.1 | SettingsModal refactor: 탭 컨테이너 | `SettingsPanel.tsx` |
| 5.2 | `GeneralTab` — 기존 글로벌 설정 (legacy 유지) | `tabs/GeneralTab.tsx` (NEW) |
| 5.3 | `AgentProfilesTab` — 좌측 profile 리스트 + 우측 편집 폼 | `tabs/AgentProfilesTab.tsx` |
| 5.4 | `McpServersTab` — transport별 폼, healthCheck, secret 입력 | `tabs/McpServersTab.tsx` |
| 5.5 | `SkillSourcesTab` — 디렉터리 추가, trust 토글, refresh | `tabs/SkillSourcesTab.tsx` |
| 5.6 | `PermissionsTab` — actionType 매트릭스 (v1에서는 profile 폼 내부로 합칠 수 있음) | `tabs/PermissionsTab.tsx` |
| 5.7 | SKILL.md 위저드 (v1은 텍스트 템플릿 복사만) | `tabs/SkillWizardDrawer.tsx` (NEW) |
| 5.8 | AgentsPanel 리팩터 — workerProfiles CRUD 제거 | `AgentsPanel.tsx` |

**Risk**: Medium. **Est**: 2.0d.

---

### Phase 6 — UI 폴리시 & 마이그레이션 UX

| # | 작업 |
|---|------|
| 6.1 | First-run 마이그레이션 다이얼로그 |
| 6.2 | MCP healthCheck UX: 뱃지 + 마지막 검사 시각 |
| 6.3 | Skill source trust 승격 경고 모달 |
| 6.4 | Permissions 매트릭스 시각화 (글로벌 vs profile override 충돌 경고) |
| 6.5 | Secret 입력 폼: 값 표시 없음, 변경 시 새 값으로 overwrite만 |
| 6.6 | accessibility — 탭 키네비, ARIA, focus trap |
| 6.7 | i18n (한국어 우선) |
| 6.8 | E2E (Playwright) — profile create → MCP add → skill source register → invocation |

**Risk**: Low~Medium. **Est**: 1.5d.

---

## 6. 저장 전략 트레이드오프

| 옵션 | 장점 | 단점 | 결론 |
|------|------|------|------|
| (A) 단일 JSON 확장 | 마이그레이션 코드 최소, atomic update | row 비대, 부분 update 어려움, query 불가 | ✗ |
| (B) 도메인별 테이블 분리 | 부분 update, 인덱스 가능, 제약 활용 | 마이그레이션 step 증가 | ✓ |
| (C) 하이브리드 — `HarnessSettings`엔 글로벌 포인터만, 나머지 분리 | (B) + 글로벌 상태 한 곳 | 약간의 중복 | ✓ 채택 |

---

## 7. 보안 고려

| 영역 | 결정 | 근거 |
|------|------|------|
| 자격증명 저장 | Electron `safeStorage` (Win=DPAPI / macOS=Keychain / Linux=libsecret/Basic) | native dep 회피, 이미 의존성 포함 |
| safeStorage 미가용 fallback | 시작 시 `isEncryptionAvailable()` 체크, 미가용 시 `secret:write` 거부 + UI 경고 | 평문 디스크 저장 금지 |
| Secret IPC | `write`/`clear`/`listKeys`만. `read`는 main 내부에서만 | least-privilege |
| MCP server spawn | child process, `shell: false`, env 명시 키만, cwd=profile sandbox primary dir | 기존 ModelCliAdapter 패턴 |
| MCP server 격리 | stdio MCP는 spawn. http/sse는 외부 endpoint trust 확인 메시지 + per-server timeout | 외부 URL 자동 신뢰 금지 |
| Skill root 화이트리스트 | 절대경로만, `..` 거부, sourceDir prefix check (기존 `isWithin` 재사용) | path-policy 일관성 |
| Custom skill 기본 trust | **false**. 명시 승격해야 `skill_script` 실행 가능 | 무결성 |
| secret 로그 누출 방지 | secret-redactor를 MCP env 키 패턴(`*_TOKEN`, `*_KEY`, `*_SECRET`)으로 확장 | 기존 redaction layer 활용 |

---

## 8. 마이그레이션 전략

### 8.1 `WorkerProfile` → `AgentProfile`

기존 `WorkerProfile`은 lossy → 다음 기본값을 채운다:

```
AgentProfile = {
  ...identity(workerProfile),
  description: '', persona: '',
  tuning: {
    model: workerProfile.model,
    timeoutMs: legacy.agent.timeoutMs,
    stallTimeoutMs: legacy.agent.stallTimeoutMs,
    contextDepth: legacy.agent.contextDepth,
    systemPromptPrefix: '', systemPromptSuffix: '',
  },
  cli: { cliPathOverride: '', env: {}, envSecretRefs: {} },
  permissions: DEFAULT_AGENT_PERMISSIONS,
  mcpServerIds: [], skillSourceIds: [],
  isDefault: index === 0,
  ...timestamps,
}
```

### 8.2 단계적 대체

1. Phase 2 직후: `WorkerProfile[]`/legacy `AgentSettings`는 **유지**. 자동 마이그레이션 없음.
2. Phase 4: `AgentPlanningService`가 active AgentProfile 우선, 없으면 legacy fallback.
3. Phase 5/6: SettingsModal에 "마이그레이션" 버튼 노출. 사용자가 클릭 시 변환.
4. **deprecation 기한**: legacy는 최소 2 release 후 제거. 본 PR에서는 제거 X.

### 8.3 첫 실행 시 기본 profile 생성

DB가 비어 있고 legacy `AgentSettings`가 있으면 single "Default" profile을 lazy-create (`LocalStateService.ensureDefaultAgentProfile()`).

### 8.4 Skill source 마이그레이션

`main.ts`의 하드코딩된 `skillSources` 두 항목(project / userData)을 schema v9 적용 시점에 sentinel id(`ss_project`, `ss_user`)로 DB에 seed. trusted=true. 이후 `CapabilityRegistry.refresh`는 DB에서 조회.

---

## 9. UI 정보 구조

```
SettingsModal (탭 컨테이너)
├── General        — 글로벌 agent/orchestration/approval (legacy 호환)
├── Agents         — AgentProfile CRUD (좌측 리스트 + 우측 폼)
│   └─ 폼 섹션: Identity / Persona / Tuning / CLI Env / Permissions /
│              Connected MCP servers / Connected Skill sources
├── MCP            — McpServerConfig CRUD + healthCheck
├── Skills         — SkillSource CRUD + SKILL.md 위저드 진입점
└── (Permissions   — v1에서는 Agent 폼 내부로 합침)

AgentsPanel (workbench 메인 — 운영뷰)
├── 활성 profile 카드(이름·model·persona 요약)
├── Provider 상태(queueDepth)
├── 최근 invocation 결과·stream view
└── "Edit profiles" → SettingsModal/Agents 탭으로 이동
```

---

## 10. 위험 / 리스크

| Risk | 심각도 | 영향 | 완화 |
|------|--------|------|------|
| (a) MCP 서버 spawn 시 임의 코드 실행 | H | sandbox 우회 | shell:false, env 명시, stdio일 때만 spawn, cwd 강제 |
| (b) Skill 무결성(악성 SKILL.md) | H | skill_script 자동 승인 위험 | custom skill 기본 trusted=false, 승격 모달, 기존 `classifySkillRisk` 유지 |
| (c) Credential 누출 | H | secret이 로그/IPC에 섞일 위험 | safeStorage 강제, IPC write-only, redactor 확장 |
| (d) IPC 채널 폭증 | M | 9-layer 비용 증가 | 4 namespace에 5~7개씩, `upsert` 통합 |
| (e) 마이그레이션 호환성 | M | legacy 데이터 손실 | 자동 변환 X, 명시 버튼 + read-only 유지 |
| (f) Claude/Codex CLI 인자 미지원 | H | MCP config 전달 불가 | Claude 경로만 사용, Codex는 V2 검증 전 feature off. user-level config 직접 수정 fallback은 비채택 |
| (g) safeStorage 미가용 환경 | M | secret 저장 불가 | UI 기능 disable + 경고, 평문 fallback 금지 |
| (h) MCP temp config 파일 누수 | L | 종료 직후 cleanup 누락 | try/finally + 시작 시 `harness-mcp-*` 청소 |
| (i) Path policy registry race | M | 추가 직후 invocation 미반영 | event-bus broadcast로 캐시 invalidation |
| (j) workerProfile vs AgentProfile 이중 진실 | M | 같은 role 다른 동작 | resolver에서 AgentProfile 우선, legacy alias |

---

## 11. 테스트 전략

### Unit
- `agent-profile-repository.test.mjs` — CRUD, unique default 제약, JSON round-trip
- `mcp-server-repository.test.mjs` — transport별 validation, secret 키 분리
- `skill-source-repository.test.mjs` — UNIQUE root_dir, trust 토글
- `secret-vault.test.mjs` — safeStorage available/unavailable 양쪽
- `mcp-config-builder.test.mjs` — profile→config 합성, secret 복호화, temp 격리
- `profile-migrator.test.mjs` — legacy → AgentProfile 결과 스냅샷

### Integration
- `migrations.test.mjs` — v6 → v10 chain
- `agents-ipc.test.mjs` / `mcp-ipc.test.mjs` (FakeWindow)
- `cli-adapter-mcp.test.mjs` — Claude spawn args에 `--mcp-config <path>` 포함, Codex args에는 미포함 검증
- `path-policy.test.mjs` — 사용자 등록 root 화이트리스트 진입

### E2E (Playwright)
- SettingsModal → Agents → 생성 → 활성화 → invocation에 persona prefix 확인
- MCP → server 추가 → secret → healthCheck → profile 연결 → invocation
- Skills → custom dir 등록 → trust 거부 시 skill_script 차단

---

## 12. 복잡도 추정

| Phase | 작업량 | 누적 |
|-------|--------|------|
| Phase 1 — 타입 모델 | 0.5d | 0.5d |
| Phase 2 — 저장소·마이그레이션·SecretVault | 1.5d | 2.0d |
| Phase 3 — IPC 핸들러 | 1.5d | 3.5d |
| Phase 4 — 서비스 wiring & CLI 통합 | 2.5d | 6.0d |
| Phase 5 — UI 골격 | 2.0d | 8.0d |
| Phase 6 — UI 폴리시·마이그레이션 UX | 1.5d | 9.5d |
| V1/V2 실측 + 디버깅 버퍼 | 0.5d | **10.0d** |

1d = 풀 포커스 6h effective. 캘린더 기준 2.5~3주.

---

## 13. 롤아웃 권장 순서

| PR | 포함 | 사용자 영향 | 머지 조건 |
|----|------|-------------|-----------|
| PR-1 | Phase 1 + Phase 2 | 없음 (런타임 동일) | 마이그레이션 dry-run 통과 |
| PR-2 | Phase 3 read-only + Phase 5 GeneralTab + AgentProfilesTab(read) | profile 조회 가능 | SettingsPanel 회귀 없음 |
| PR-3 | Phase 3 mutate + AgentProfilesTab 편집 | profile CRUD 가능 (invocation은 legacy) | profile-migrator OK |
| PR-4 | Phase 4 CLI 통합 (MCP는 feature flag로 off) | persona/tuning/permissions 실제 적용 | V1/V2 완료 |
| PR-5 | MCP feature flag on + McpServersTab + healthCheck UX | MCP 사용 가능 | spawn 격리 검증, 보안 리뷰 |
| PR-6 | SkillSourcesTab + SKILL.md 위저드 | custom skill source | path-policy 검증 |
| PR-7 | 마이그레이션 UX + deprecation 알림 | 명시 마이그레이션 | E2E 통과 |

**핵심 원칙**: PR-1·PR-2는 무변경 → 빠른 머지. PR-4·PR-5는 보안 리뷰 게이트. MCP는 feature flag 뒤.

---

## §검토 (자체 review)

### A. 이 설계가 무너지는 시나리오 3가지

1. **Claude CLI가 invocation별 MCP config 인자를 지원하지 않을 경우**
   현재 설계는 `--mcp-config <path>` 류 인자 존재를 가정. 실측 시 Anthropic CLI가 오직 `~/.claude.json`만 보거나 `claude mcp add` 서브커맨드로만 user-level 등록을 허용한다면 **invocation별 격리 불가**. R2 핵심이 깨진다. → 차선책: invocation 직전 `~/.claude.json` atomic write + 종료 시 restore. 동시 invocation·crash 시 user 글로벌 config 손상 위험. **V1 실패 시 MCP per-profile은 단념, "global MCP" 단일 셋으로 축소**.

2. **safeStorage가 가용하지 않을 때 (Linux headless / WSL / CI runner)**
   secret 저장 불가 → MCP envSecretRefs · CLI envSecretRefs 무력화. UI에서 secret 입력란만 보고 write IPC가 실패하면 혼란. **safeStorage 가용성 사전 체크 후 secret UI를 숨김 처리**해야 하며 평문 fallback 금지.

3. **AgentProfile vs orchestration.workerProfiles 이중 진실 정합성 붕괴**
   Phase 4 resolver가 active AgentProfile을 우선하더라도 OrchestrationService 내부에서 workerProfile.role로 모델을 선택하는 경로가 남아 있으면 같은 role에 두 다른 model/persona가 적용. 사용자가 orchestration에서 workerProfile.model을 바꿔도 AgentsTab은 그대로일 때 "왜 모델이 다르지?". → 완화: PR-4부터 workerProfile 편집 UI를 read-only로 전환하고 "AgentProfiles로 이동" 안내 강제.

### B. 단순화 가능한 항목

- **Permissions 매트릭스 탭**: 별도 탭은 과설계. AgentProfile 폼 내 "Permissions" 섹션으로 충분. 일괄 편집은 v2.
- **MCP healthCheck**: `mcp:upsert` 응답에 동기 결과 포함으로 단순화. 비동기 polling은 v2.
- **transport별 폼 분기**: stdio/http/sse 각각 별개 폼 X. `transport` select 변경 시 show/hide만.
- **SKILL.md 위저드**: 텍스트 템플릿 클립보드 복사로 충분. 파일 생성은 v2.
- **`activeAgentProfileId` 추가 vs isDefault 단일**: 두 개념 동시 도입 금지. **isDefault만**으로 시작, active는 후속 PR.

### C. 지금은 하지 말고 미뤄야 할 항목

1. **MCP scope=per-agent 의미 미세 정의** — v1은 global만, profile은 enabled list 관리.
2. **MCP healthCheck 자동 polling / 상태 push 이벤트** — v1 수동 버튼만.
3. **사용자 등록 skill root watch / hot-reload** — v1 명시 refresh.
4. **AgentProfile per-thread override** — v2.
5. **SKILL.md 위저드 파일 쓰기** — v2.
6. **Codex CLI MCP 통합** — V2 검증 결과에 따라 Phase 4에서 명시적 미지원 표기, Claude만 우선.
7. **CLI 경로 + secret 결합 테스트 매트릭스 전체** — "override 없음+secret 없음" / "override 있음+secret 있음" 두 케이스로 한정.

---

## 14. 핵심 파일 경로 (구현 시 직접 수정/생성)

- `packages/core/src/types/settings.ts`
- `packages/core/src/ipc-channels.ts`
- `packages/core/src/api.ts`
- `packages/storage/src/schema.ts`
- `packages/storage/src/migrations.ts`
- `packages/storage/src/repositories/settings-repository.ts`
- `packages/storage/src/services/local-state-service.ts`
- `packages/agent/src/model-cli-adapter.ts`
- `packages/agent/src/model-cli-types.ts`
- `packages/agent/src/agent-planning-service.ts`
- `packages/agent/src/agent-prompt-builder.ts`
- `packages/skillify-adapter/src/capability-service.ts`
- `packages/skillify-adapter/src/skill-loader.ts`
- `apps/desktop/electron/main.ts`
- `apps/desktop/electron/preload.ts`
- `apps/desktop/electron/ipc/settings-ipc.ts`
- `apps/desktop/electron/ipc/index.ts`
- `apps/desktop/src/screens/workbench/SettingsPanel.tsx`
- `apps/desktop/src/screens/workbench/AgentsPanel.tsx`

**WAITING FOR CONFIRMATION**: 이 설계로 진행할까요? (yes/no/modify)
