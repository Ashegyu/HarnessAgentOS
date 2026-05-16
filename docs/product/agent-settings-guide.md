# Agent 상세 설정 가이드

> HarnessAgentOS의 Settings 다이얼로그에서 에이전트, MCP 서버, Skill 소스, Secret을 어떻게 설정하는지 설명합니다. 각 탭의 입력 필드 의미, 동작 시점, 실전 예시를 다룹니다.

**대상 독자:** HarnessAgentOS를 처음 설정하거나, 새 MCP 서버/Skill 소스를 등록하려는 사용자.

**열기:** `Ctrl+,` 또는 SlimRail 하단의 ⚒ 아이콘.

---

## 목차

1. [용어 정리](#1-용어-정리)
2. [General 탭 — 전역 기본값](#2-general-탭--전역-기본값)
3. [Agents 탭 — AgentProfile](#3-agents-탭--agentprofile)
4. [MCP 탭 — MCP 서버 연결](#4-mcp-탭--mcp-서버-연결)
5. [Skills 탭 — Skill 소스 등록](#5-skills-탭--skill-소스-등록)
6. [Secrets 탭 — Secret Vault](#6-secrets-탭--secret-vault)
7. [실전 워크플로우](#7-실전-워크플로우)
8. [문제 해결](#8-문제-해결)

---

## 1. 용어 정리

| 용어 | 의미 |
|------|------|
| **AgentProfile** | 에이전트 한 종류의 모든 설정을 묶은 단위 — 모델, 페르소나, 권한, 사용할 MCP/Skill 묶음 |
| **MCP 서버** | Model Context Protocol 외부 도구 서버. Claude가 invocation 시 spawn 하여 추가 도구를 사용하게 함 |
| **Skill 소스** | SKILL.md 파일들을 모아둔 디렉터리. Capability Registry가 스캔하여 prompt에 노출 |
| **Secret Vault** | OS 보안 저장소 (Windows DPAPI / macOS Keychain / libsecret) 로 암호화된 키-값 저장소 |
| **scope: global** | 모든 프로필이 잠재적으로 사용 가능한 MCP 서버 |
| **scope: per-agent** | 특정 AgentProfile의 `mcpServerIds`에 포함된 경우에만 사용되는 MCP 서버 |
| **활성 프로필** | 현재 invocation이 사용하는 AgentProfile. Settings에서 "Set Active"로 지정 |
| **기본 프로필** | 새 thread를 시작할 때 자동으로 선택되는 프로필 ("Set Default") |

---

## 2. General 탭 — 전역 기본값

활성 AgentProfile이 없을 때 사용되는 기본값과, 모든 thread 공통 동작을 설정합니다.

### 2.1 에이전트 섹션

| 필드 | 의미 | 예시 |
|------|------|------|
| **Provider** | CLI 종류. `auto`는 우선순위에 따라 사용 가능한 첫 CLI를 선택 | `claude`, `codex`, `auto` |
| **Model** | 모델 ID. 비워두면 provider의 기본 모델 사용 | `claude-sonnet-4-6` |
| **Timeout (ms)** | 한 invocation의 최대 시간 | `300000` (5분) |
| **Stall timeout (ms)** | stdout이 일정 시간 chunk 없으면 강제 종료 | `300000` |
| **Context depth** | prompt에 포함할 이전 turn의 개수 | `5` |

> ℹ️ AgentProfile이 활성화되어 있으면 위 값은 무시되고 프로필의 `tuning` 블록이 우선합니다.

### 2.2 Agent Orchestration (실험적)

여러 worker 에이전트가 협업하는 멀티-에이전트 모드.

| 필드 | 의미 |
|------|------|
| **활성화 토글** | OFF면 single-worker 모드로 동작 |
| **기본 Mode** | `single_worker` / `planner_worker` / `multi_worker` |
| **기본 Instruction** | 플래너 에이전트에게 항상 전달되는 시스템 지시 |
| **Worker Profiles** | `role` + provider + model 조합. 현재 실행 role은 `planner`, `coder`, `reviewer`, `tester`, `orchestrator`, `security-reviewer`, `build-error-resolver`, `refactor-cleaner`, `performance-reviewer` |

### 2.3 Approval 자동화

| 필드 | 의미 |
|------|------|
| **모든 approval 자동 승인 및 실행** | ⚠ ON이면 file_write·shell·dependency_install·git_commit·skill_script·network·orchestration_plan 모두 자동 |

이 글로벌 토글이 ON이고 AgentProfile에 별도 화이트리스트가 있어도, 정책 우선순위는 다음과 같습니다:

```
profile.permissions.block  ← 가장 강함
profile.permissions.autoApproveActions
글로벌 autoApprove 토글
사용자에게 prompt (기본)  ← 가장 약함
```

---

## 3. Agents 탭 — AgentProfile

에이전트 한 종류를 처음부터 끝까지 정의합니다.

### 3.1 필드 의미

#### Identity 섹션
- **Name** — UI에 표시되는 이름. 예: `Backend Coder`, `Security Reviewer`
- **Provider** — `claude` / `codex` / `auto`
- **Role** — 실행 단계 계약. 일반 단계는 `planner`/`coder`/`reviewer`/`tester`, 전문 단계는 `orchestrator`, `security-reviewer`, `build-error-resolver`, `refactor-cleaner`, `performance-reviewer`를 사용합니다.
- **Model** — 비워두면 provider 기본값
- **CLI 경로 override** — 시스템 PATH의 CLI가 아닌 다른 바이너리를 쓰고 싶을 때

#### Persona 섹션
- **System Prompt Persona** — 에이전트 정체성. prompt 앞에 prefix로 합성됨
- **System Prompt Prefix** — Persona 위에 더해지는 작업 컨텍스트
- **System Prompt Suffix** — output contract 뒤에 추가되는 마무리 지시

> ℹ️ 합성 순서는 `PREFIX → PERSONA → SYSTEM → OUTPUT CONTRACT → SUFFIX`. `--system-prompt` 인자로 Claude에 전달되어 `--resume`에서도 유지됩니다.

#### Tuning 섹션
- **Temperature** — 0.0~1.0
- **Max tokens** — 응답 최대 길이
- **Timeout (ms)** / **Stall timeout (ms)** — General 탭과 동일하지만 이 프로필만 override
- **Context depth** — 이 프로필 전용 turn 수

#### Permissions 섹션
ActionType별 정책 매트릭스:

| ActionType | block | autoApprove | (default) |
|-----------|:-----:|:-----------:|:--:|
| file_write | ❌ 차단 | ✅ 자동 실행 | 🔵 사용자 prompt |
| shell | ❌ | ✅ | 🔵 |
| dependency_install | ❌ | ✅ | 🔵 |
| git_commit | ❌ | ✅ | 🔵 |
| skill_script | ❌ | ✅ | 🔵 |
| network | ❌ | ✅ | 🔵 |
| orchestration_plan | ❌ | ✅ | 🔵 |

#### MCP / Skill 바인딩
- **MCP Server IDs** — 이 프로필에서 활성화할 `per-agent` scope MCP들
- **Skill Source IDs** — 이 프로필에 노출할 skill 소스들 (비워두면 모든 trusted 소스)

### 3.2 액션 버튼

| 버튼 | 동작 |
|------|------|
| **Save** | 변경사항 저장 (validation 통과 시) |
| **Set Active** | 이 프로필을 현재 활성 프로필로 지정 |
| **Set Default** | 새 thread 생성 시 자동 선택되는 프로필로 지정 |
| **Delete** | 프로필 삭제 (활성/기본 프로필이면 차단됨) |

### 3.3 마이그레이션 배너

기존 WorkerProfile만 있고 AgentProfile이 하나도 없는 환경에서는 상단에 배너가 나타납니다.

```
이전 Worker Profile을 새 AgentProfile로 옮길 수 있습니다.
[마이그레이션 실행]
```

클릭 시 1:1 변환되며 (lossy — persona/permissions는 default), 이후 직접 편집해야 합니다. 이미 손으로 만든 AgentProfile이 있으면 배너가 자동으로 사라집니다 (덮어쓰기 방지).

### 3.4 프로필 예시

#### 예시 1 — Strict Reviewer
```yaml
name: Strict Reviewer
provider: claude
model: claude-sonnet-4-6
persona: |
  당신은 보안과 가독성에 엄격한 코드 리뷰어입니다.
  변경된 파일만 분석하고, 새 코드를 작성하지 않습니다.
tuning:
  temperature: 0.1
  timeoutMs: 180000
permissions:
  block: [file_write, shell, git_commit, dependency_install]
  autoApproveActions: []
mcpServerIds: []
```

#### 예시 2 — Full-Auto Coder (위험)
```yaml
name: Full-Auto Coder
provider: claude
model: claude-opus-4-7
persona: 빠른 프로토타이핑 코더. 안전 망 없이 작동.
permissions:
  block: []
  autoApproveActions: [file_write, shell, dependency_install]
mcpServerIds: [mcp_fs, mcp_github]
```

---

## 4. MCP 탭 — MCP 서버 연결

[Model Context Protocol](https://modelcontextprotocol.io) 서버를 등록하여 Claude에게 도구를 추가합니다.

### 4.1 필드 의미

#### Identity
- **이름** — 사용자가 보는 식별 라벨. CLI 전달 시 자동으로 sanitize됨 (`Filesystem MCP` → `filesystem_mcp`)
- **설명** — 메모. CLI에는 전달되지 않음
- **Scope** — `global` (모든 프로필 후보) / `per-agent` (특정 프로필만)
- **활성화** — OFF면 spawn되지 않음

#### Transport
세 가지 transport를 지원합니다:

**stdio** — 로컬 프로세스 spawn
```
실행 파일 경로: /usr/local/bin/mcp-fs
인자 (공백 구분): --root /tmp
```

**http** — 원격 HTTP endpoint
```
URL: https://mcp.example.com/v1
```

**sse** — Server-Sent Events
```
URL: https://mcp.asana.com/sse
```

#### 환경변수
- **env** (각 줄 `KEY=VALUE`) — 평문. 일반적인 비밀 아닌 설정용
- **envSecretRefs** (각 줄 `KEY=secret_vault_key`) — Secret Vault에 저장된 키 이름만 적음. 평문 값은 spawn 시점에 main process가 복호화하여 주입

**예시 — Filesystem MCP**
```
env:
  LOG_LEVEL=info
  ALLOW_WRITE=false

envSecretRefs:
  API_TOKEN=fs_token_key
```

위 설정은 spawn 시 다음과 같이 합성됩니다:
```json
{
  "mcpServers": {
    "filesystem_mcp": {
      "command": "/usr/local/bin/mcp-fs",
      "args": ["--root", "/tmp"],
      "env": {
        "LOG_LEVEL": "info",
        "ALLOW_WRITE": "false",
        "API_TOKEN": "<vault에서 복호화된 실제 값>"
      }
    }
  }
}
```

이 JSON은 `userData/mcp-tmp/mcp-<uuid>.json`에 임시 파일로 (mode 0o600) 저장되고 `claude --mcp-config <path> --strict-mcp-config` 인자로 전달됩니다. Claude의 user/project MCP 설정은 workbench 실행에 섞지 않습니다. invocation 종료 시 자동 삭제됩니다.

### 4.2 액션

| 버튼 | 동작 |
|------|------|
| **저장** | DB에 upsert |
| **활성화 / 비활성화** | enabled 플래그 토글 |
| **Health check** | stdio: spawn 후 MCP 표준 `Content-Length` 프레임으로 JSON-RPC `initialize`를 보내 응답 확인 (3s 타임아웃, 줄 단위 JSON 응답도 호환) <br> http/sse: HEAD 요청 후 실패 시 GET으로 reachability 재확인 |
| **삭제** | DB에서 제거. 활성 프로필이 참조 중이면 invocation 시 자동으로 빠짐 |

### 4.3 Provider 별 동작

| Provider | MCP 지원 | 비고 |
|----------|:-------:|------|
| `claude` | ✅ | `--mcp-config <path>` 인자로 전달 |
| `codex` | ❌ | V2 검증 전이라 미지원. 인자 생성은 skip되고 CLI에는 전달되지 않음 |
| `auto` | ✅ (claude 선택 시) | provider-detection 결과에 따름 |

### 4.4 HTTP/SSE 인증

`envSecretRefs`에서 `AUTH` 키를 정의하면 자동으로 `Authorization: Bearer <값>` 헤더가 합성됩니다:

```
envSecretRefs:
  AUTH=remote_api_bearer
```

생성되는 JSON:
```json
{
  "type": "http",
  "url": "https://mcp.example.com/v1",
  "headers": {
    "Authorization": "Bearer <vault에서 복호화>"
  }
}
```

기타 헤더는 `env` 항목으로 추가됩니다.

---

## 5. Skills 탭 — Skill 소스 등록

Capability Registry가 SKILL.md를 스캔할 디렉터리를 등록합니다.

### 5.1 미리 등록된 소스

| Source | 위치 | 신뢰 | 비고 |
|--------|------|:----:|------|
| `skillify:project` | `HarnessAgentOS/skills/` | ✅ | 앱 번들에 포함. 읽기 전용 |
| `skillify:user` | `<userData>/skills/` | ✅ | 사용자가 직접 추가/수정 가능 |

두 소스는 처음 부팅 시 `ensureSeed`로 자동 생성되며 삭제할 수 없습니다.

### 5.2 커스텀 소스 추가

`+ 소스 추가` 클릭 → 폴더 선택 다이얼로그.

| 필드 | 의미 |
|------|------|
| **이름** | UI 라벨 (자동으로 폴더명으로 채워짐) |
| **루트 디렉터리** | 절대 경로 |
| **신뢰됨** | 신규 소스는 항상 `false`로 시작. 신뢰하기 전까지는 capability registry에 노출되지만 `skill_script` 실행은 차단됨 |

### 5.3 액션

| 액션 | 동작 |
|------|------|
| **Enable / Disable** | invocation에 노출 여부 |
| **Trust** | 확인 모달 (`이 디렉터리는 임의 코드를 실행할 수 있습니다`) 후 신뢰 ON |
| **Refresh** | SKILL.md 파일들을 다시 스캔하여 Capability Registry 갱신 |
| **Remove** | 커스텀 소스만 가능. project/user sentinel은 차단 |

### 5.4 SKILL.md 구조 예시

```markdown
---
name: optimize-bundle
description: Webpack bundle size 분석 및 최적화 제안
allowed-tools: Read, Bash(npx webpack-bundle-analyzer:*)
---

이 스킬은 다음 단계로 진행합니다:

1. `npx webpack-bundle-analyzer` 실행
2. dependency tree 분석
3. 분리 가능한 chunk 제안
```

`name` 필드가 capability ID가 되며 (snake_case), prompt에 노출됩니다.

---

## 6. Secrets 탭 — Secret Vault

OS 보안 저장소에 비밀 값을 암호화 저장합니다.

### 6.1 동작 방식

- 값은 main process에서 `safeStorage.encryptString()` 으로 즉시 암호화
- DB에는 암호문 BLOB만 저장
- **renderer는 평문에 절대 접근할 수 없음** — `secret.read` IPC 채널이 존재하지 않음
- spawn 시점에 main process가 복호화하여 child process env로 주입

### 6.2 키 명명 규칙

| 허용 | 불허 |
|------|------|
| `A-Z a-z 0-9 _ - .` | 공백, `=`, 한글, 특수문자 |

예시:
- ✅ `github_token`
- ✅ `mcp.fs.api_key`
- ✅ `OPENAI-API-KEY`
- ❌ `my key` (공백)
- ❌ `key=val` (등호)

### 6.3 사용 흐름

```
1. Secrets 탭 → [+ 새 Secret]
2. 키 이름: fs_token_key
3. 값: ghp_xxxxxxxxxxxxxxxx
4. 저장 → DPAPI 암호화 후 DB에 저장
5. 이제 MCP 탭의 envSecretRefs에서 참조 가능:
   API_TOKEN=fs_token_key
```

### 6.4 한계

- 값을 다시 보거나 export할 방법 없음 (보안 설계)
- 잊었다면 삭제 후 재등록
- DPAPI/Keychain이 사용 불가한 환경 (예: SSH 헤드리스 Linux)에서는 `write()`가 `SecretVaultUnavailableError`를 던지며 배너로 안내

---

## 7. 실전 워크플로우

### 7.1 Filesystem MCP 서버 추가

```
1. Secrets 탭에서 키 등록
   - 키: fs_token_key
   - 값: <실제 API 토큰>

2. MCP 탭에서 [+ 새 서버]
   - 이름: Filesystem MCP
   - Scope: global
   - Transport: stdio
   - 실행 파일: npx
   - 인자: -y @modelcontextprotocol/server-filesystem /home/me
   - envSecretRefs:
       API_TOKEN=fs_token_key
   - 저장

3. [Health check] → "OK · 14:32:01"

4. 다음 thread invocation에서 자동으로 spawn됨
```

### 7.2 보안 리뷰 전용 프로필

```
1. Agents 탭 → [+ 새 프로필]
   - Name: Security Reviewer
   - Persona: |
       당신은 OWASP Top 10에 정통한 보안 리뷰어입니다.
       변경된 코드만 분석하고 새 코드를 작성하지 않습니다.
   - Permissions:
       block: [file_write, shell, git_commit]
   - mcpServerIds: []  # 도구 없이 분석만

2. [Set Default] 클릭 → 새 thread는 이 프로필로 시작
```

### 7.3 SSE 기반 hosted MCP 연결

```
1. Secrets 탭
   - 키: asana_bearer
   - 값: <Asana API token>

2. MCP 탭
   - Transport: sse
   - URL: https://mcp.asana.com/sse
   - envSecretRefs:
       AUTH=asana_bearer
   - 저장
```

`AUTH` 키는 자동으로 `Authorization: Bearer <값>` 헤더로 변환됩니다.

### 7.4 프로젝트 전용 Skill 추가

```
1. ~/my-project/.harness-skills/seo-audit/SKILL.md 작성

2. Skills 탭 → [+ 소스 추가] → 폴더 선택
   - 이름: my-project skills (자동 채워짐)
   - 루트: ~/my-project/.harness-skills

3. [Trust] → 확인 모달 → 신뢰

4. [Refresh] → Capability Registry에 등록됨

5. 다음 invocation에서 prompt에 `seo-audit` capability가 노출됨
```

---

## 8. 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| MCP 서버가 invocation에서 사용되지 않음 | `enabled: false` 이거나 `scope: per-agent`인데 활성 프로필이 참조하지 않음 | 토글 켜기 / 프로필의 `mcpServerIds`에 추가 |
| Windows에서 `npx`, `uvx`, `npm` 기반 MCP startup이 실패 | bare command가 `.cmd`/`.exe`로 해석되지 않거나 stdio probe가 MCP 프레임 응답을 못 읽는 경우 | 최신 앱에서는 PATH/PATHEXT 기준으로 command를 해석하고 `Content-Length` 프레임을 지원합니다. 그래도 실패하면 Health check의 stderr 메시지를 보고 실행 파일 경로/인자/secret을 확인하세요 |
| Health check가 `probe timeout (3s)` | stdio MCP가 stdin에서 JSON-RPC를 읽지 못함 | 서버 구현체 검증 — 표준 MCP protocol을 따라야 함 |
| `secret vault key "X" could not be resolved` | envSecretRefs에 참조한 키가 Secret Vault에 없음 | Secrets 탭에서 해당 키 등록 |
| Skill이 prompt에 안 보임 | 소스가 disabled이거나 SKILL.md frontmatter 오류 | Refresh 시 콘솔에서 파싱 오류 확인 |
| 마이그레이션 배너가 안 사라짐 | AgentProfile이 하나도 없는 상태 | 빈 프로필이라도 하나 저장하면 사라짐 |
| Codex에서 MCP가 동작 안 함 | Codex CLI MCP 인자 형식 V2 검증 전 | Claude provider 사용 (현재 제한) |
| `SecretVaultUnavailableError` | OS 보안 저장소 미사용 환경 (헤드리스 Linux 등) | libsecret 설치 또는 Desktop 환경에서 실행 |

---

## 참고 문서

- [Implementation Plan: Agent별 상세 설정](../design/agent-detailed-settings.md) — 설계 결정과 phase 계획
- [IPC Contracts](../contracts/ipc-contracts.md) — 9-layer IPC 명세
- [Workbench V2 Migration](../design/workbench-v2-migration.md) — UI 레이아웃 진화
