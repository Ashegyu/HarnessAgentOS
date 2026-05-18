export type FeatureHelpId =
  | "workbench"
  | "threads"
  | "taskRun"
  | "targetDir"
  | "settings"
  | "agentProfiles"
  | "pipelines"
  | "remoteAgents"
  | "mcpServers"
  | "skills"
  | "secrets"
  | "agentPlan"
  | "approvals"
  | "artifacts"
  | "quality"
  | "capabilities"
  | "learner"
  | "instinct"
  | "orchestration"
  | "topology";

export interface FeatureHelpEntry {
  id: FeatureHelpId;
  title: string;
  summary: string;
  details: readonly string[];
  location: string;
}

export const FEATURE_HELP: Record<FeatureHelpId, FeatureHelpEntry> = {
  workbench: {
    id: "workbench",
    title: "워크벤치",
    summary:
      "스레드, 작업 실행, 승인, 산출물, 품질 확인을 한 화면에서 감독하는 메인 작업 공간입니다.",
    details: [
      "사용자는 대화 입력과 패널을 통해 흐름을 통제하고, 에이전트는 승인된 범위 안에서만 실행됩니다.",
      "좌측은 스레드와 작업 목록, 중앙은 대화와 결과, 우측은 선택한 TaskRun의 세부 상태를 보여줍니다.",
    ],
    location: "메인 화면",
  },
  threads: {
    id: "threads",
    title: "스레드",
    summary:
      "관련 작업들을 하나의 대화 단위로 묶고, 기본 작업 폴더와 기본 파이프라인을 기억합니다.",
    details: [
      "새 요청은 선택된 스레드 아래 TaskRun으로 쌓입니다.",
      "스레드별 target directory를 지정하면 이후 실행 컨텍스트에 반영됩니다.",
    ],
    location: "좌측 스레드 패널",
  },
  taskRun: {
    id: "taskRun",
    title: "TaskRun",
    summary:
      "사용자 요청 하나가 계획, 승인, 실행, 산출물, 품질 평가를 거쳐 완료되는 단위입니다.",
    details: [
      "TaskRun을 선택하면 우측 패널에서 plan, approvals, artifacts, quality 상태를 확인할 수 있습니다.",
      "9가지 상태(drafting, waiting_for_approval, running, paused, blocked, quality_failed, ready_for_review, done, cancelled) 사이를 전이하며, markDone은 통과 또는 경고 수준의 QualityGate가 있어야 호출됩니다.",
      "Pause / Resume / Retry / Cancel은 우측 액션 영역에서 비종료 상태일 때만 노출되며, Cancel은 비어있지 않은 사유와 함께 quality_report artifact를 남깁니다.",
      "Retry는 blocked / quality_failed 상태에서만 가능하며 가장 최근에 승인된 action을 동일한 idempotent runner 경로로 다시 실행합니다.",
    ],
    location: "중앙 대화 타임라인 및 우측 패널",
  },
  targetDir: {
    id: "targetDir",
    title: "작업 폴더",
    summary:
      "에이전트와 runner가 실제로 읽고 쓸 기준 폴더입니다. 요청마다 실행 범위를 명확히 고정합니다.",
    details: [
      "Renderer는 폴더를 직접 접근하지 않고 Electron IPC를 통해 선택/검증합니다.",
      "승인된 side effect도 작업 폴더 정책과 runner policy를 다시 통과해야 실행됩니다.",
    ],
    location: "대화 입력 상단 및 스레드 설정",
  },
  settings: {
    id: "settings",
    title: "설정",
    summary:
      "에이전트, 파이프라인, 원격 에이전트, MCP, Skill, Secret 같은 실행 환경을 조정하는 화면입니다.",
    details: [
      "설정 변경은 preload API를 통해 main process로 전달되고 SQLite 상태에 저장됩니다.",
      "전역 자동 승인과 프로필 권한은 함께 적용되며, block 정책이 항상 우선합니다.",
    ],
    location: "좌측 레일의 설정 버튼",
  },
  agentProfiles: {
    id: "agentProfiles",
    title: "Agent Profiles",
    summary:
      "에이전트의 role, 한국어 프롬프트, 모델, 권한 정책, 비용 한도를 재사용 가능한 프로필로 관리합니다.",
    details: [
      "계획, 구현, 리뷰, 검증, 오케스트레이션, 보안, 빌드 복구, 리팩터링, 성능 검토 role을 분리할 수 있습니다.",
      "프로필 편집 화면에서 각 role의 설명과 사용 기준을 확인하고, 에이전트 ROLE 프롬프트를 한국어로 조정할 수 있습니다.",
      "action type별 기본, 자동 승인, 차단 권한을 지정해 안전 경계를 세분화합니다. 차단(blockedActions)은 자동 승인 토글을 우회합니다.",
      "Budget 섹션에서 호출당, TaskRun 누적, 일일 누적 USD 한도를 설정하면 추정 비용이 초과되는 자동 승인은 budget 단계에서 차단됩니다.",
    ],
    location: "설정 > Agents",
  },
  pipelines: {
    id: "pipelines",
    title: "Pipelines",
    summary:
      "여러 Agent Profile을 순서 또는 의존 관계로 묶어 반복 가능한 작업 흐름을 만듭니다.",
    details: [
      "각 step은 Agent Profile, 한국어 instruction 프롬프트, output contract, 허용 action을 따로 가질 수 있습니다.",
      "요청 유형 추천에 '빌드 에러', '리팩터링', '보안 리뷰' 같은 문구를 입력하면 role 구성을 기준으로 맞는 템플릿을 우선 표시합니다.",
      "TaskRun을 시작할 때 파이프라인을 선택하면 orchestration plan이 생성되고 승인 흐름을 탑니다.",
      "기본 템플릿은 저장된 선택지만 제공하며 자동 실행이나 기본 파이프라인 지정은 하지 않습니다.",
    ],
    location: "설정 > Pipelines 및 대화 입력의 Pipeline 선택",
  },
  remoteAgents: {
    id: "remoteAgents",
    title: "Remote Agents",
    summary:
      "외부 A2A agent endpoint를 등록하고, 신뢰된 endpoint만 파이프라인 step에서 사용할 수 있게 합니다.",
    details: [
      "등록된 endpoint는 health/status를 표시하고 enabled/trusted 상태를 따로 관리합니다.",
      "HarnessAgentOS는 serverless 경계를 유지하며, 외부 endpoint 호출도 approval 흐름과 연결됩니다.",
    ],
    location: "설정 > Remote Agents",
  },
  mcpServers: {
    id: "mcpServers",
    title: "MCP Servers",
    summary:
      "외부 도구 컨텍스트를 제공하는 MCP 서버 설정을 관리합니다.",
    details: [
      "서버 설정은 renderer에서 직접 실행되지 않고 main process의 IPC surface를 통해 관리됩니다.",
      "위험한 capability는 approval과 프로필 권한 정책을 통해 제어됩니다.",
    ],
    location: "설정 > MCP",
  },
  skills: {
    id: "skills",
    title: "Skills",
    summary:
      "SKILL.md 기반 기능 패키지를 등록, 신뢰, 재스캔하고 새 skill 초안을 만들 수 있습니다.",
    details: [
      "custom source는 trust 승격 전까지 script 실행 권한을 갖지 않습니다.",
      "Skill 후보는 capability recommendation으로 표시되며, 사용 여부는 승인 흐름을 통해 결정됩니다.",
    ],
    location: "설정 > Skills 및 우측 Capabilities 패널",
  },
  secrets: {
    id: "secrets",
    title: "Secrets",
    summary:
      "API key나 token 같은 민감 값을 로컬 secret vault에 저장해 실행 시점에 참조합니다.",
    details: [
      "값은 renderer에 불필요하게 노출하지 않고, 필요한 순간에 제한된 IPC를 통해 다룹니다.",
      "Secret은 runner나 원격 호출과 결합될 때 approval/policy 경계를 함께 따릅니다.",
    ],
    location: "설정 > Secrets",
  },
  agentPlan: {
    id: "agentPlan",
    title: "Agent Plan",
    summary:
      "CLI agent가 사용자 요청을 해석해 실행 후보와 산출물 기대치를 구조화하는 단계입니다.",
    details: [
      "자연어 설명과 별도로 파싱 가능한 plan block을 생성하지만, JSON은 곧바로 신뢰하지 않습니다.",
      "실행 후보는 validation과 runner policy를 통과한 뒤 approval row로 바뀝니다.",
    ],
    location: "우측 Agent / Plan 패널",
  },
  approvals: {
    id: "approvals",
    title: "Approvals",
    summary:
      "파일 쓰기, shell, network, git commit 같은 side effect를 사용자가 승인하기 전까지 막는 안전 게이트입니다.",
    details: [
      "승인은 pending, approved, executed 같은 상태로 추적됩니다.",
      "전역 auto-approve가 켜져 있어도 profile block, manual-only policy, budget 초과는 우선 적용됩니다.",
      "각 approval 카드의 '결정 trace' 토글로 7단계 결정 흐름(blocked → policy → budget → profile → manual policy → worker file → global)을 확인할 수 있습니다. 자동 승인된 결정도 어느 단계가 판단했는지 추적됩니다.",
      "Skill 등록 시 신뢰 승격 전에는 script 실행 권한이 부여되지 않으며 모든 위험 capability는 approval 흐름을 거칩니다.",
    ],
    location: "우측 Plan > Approvals",
  },
  artifacts: {
    id: "artifacts",
    title: "Artifacts",
    summary:
      "plan, stdout/stderr, 파일 diff, 실행 결과 같은 증거를 TaskRun에 연결해 남기는 기록입니다.",
    details: [
      "품질 평가와 완료 판단은 artifact evidence를 기반으로 합니다.",
      "사용자는 작업이 실제로 무엇을 만들었고 어떤 명령이 실행됐는지 나중에 다시 확인할 수 있습니다.",
    ],
    location: "우측 Files 패널",
  },
  quality: {
    id: "quality",
    title: "Quality Gate",
    summary:
      "작업이 완료 상태로 넘어가기 전에 evidence 기반으로 통과, 경고, 실패를 판단합니다.",
    details: [
      "markDone은 passed 또는 warning QualityGate가 있어야 호출할 수 있습니다.",
      "실패 또는 누락 evidence가 있으면 repair loop나 재실행 판단의 근거가 됩니다.",
    ],
    location: "우측 QA 패널",
  },
  capabilities: {
    id: "capabilities",
    title: "Capabilities",
    summary:
      "현재 요청에 도움이 될 Skill이나 기능 후보를 추천하고, 사용 승인 여부를 기록합니다.",
    details: [
      "추천은 capability metadata, trigger terms, risk level을 바탕으로 만들어집니다.",
      "승인된 capability는 나중의 agent prompt/context에 반영됩니다.",
    ],
    location: "우측 Caps 패널",
  },
  learner: {
    id: "learner",
    title: "Learner",
    summary:
      "과거 trace와 결과를 이용해 모델, capability, 실행 패턴 추천을 개선하는 보조 레이어입니다.",
    details: [
      "Learner는 실행자가 아니라 추천자이며, side effect를 직접 수행하지 않습니다.",
      "추천 결과는 approval과 agent prompt 구성에 반영될 수 있고, 모델 추천에는 추정 비용(estimatedCostUsd)이 함께 표시됩니다.",
      "LearningTrace는 reward, latency, success를 post-hoc 기록합니다. 비용 한도 enforcement는 Agent Profile의 Budget 설정과 결합해 사전(pre-execution) 단계에서 작동합니다.",
    ],
    location: "우측 Caps > Learner",
  },
  instinct: {
    id: "instinct",
    title: "Instinct",
    summary:
      "현재 프로젝트와 요청 맥락에서 즉시 검토할 만한 후보 action이나 risk를 점수화합니다.",
    details: [
      "후보 점수는 관찰된 project key, capability metadata, 최근 작업 맥락을 활용합니다.",
      "실행은 항상 별도 approval과 runner policy를 거칩니다.",
    ],
    location: "우측 Inst 패널",
  },
  orchestration: {
    id: "orchestration",
    title: "Orchestration",
    summary:
      "단일 agent가 아니라 여러 step/worker가 연결된 작업 계획을 만들고 실행 흐름을 관리합니다.",
    details: [
      "legacy mode와 pipeline mode를 모두 다루되, 실제 side effect는 approval 이후 runner가 실행합니다.",
      "작업 순서와 의존성은 pipeline/topology 정책에 따라 결정됩니다.",
    ],
    location: "우측 Orch 패널 및 설정 > Pipelines",
  },
  topology: {
    id: "topology",
    title: "Topology Recommendation",
    summary:
      "선택한 TaskRun과 등록된 Agent Profile을 바탕으로 적절한 pipeline 구조 후보를 제안합니다.",
    details: [
      "추천은 draft에 적용하기 전까지 실행 계획이 아니며, 사용자가 선택해야 반영됩니다.",
      "적용/무시 feedback은 이후 추천 품질을 개선하는 trace로 남습니다.",
    ],
    location: "설정 > Pipelines > Topology Recommendation",
  },
};

export const FEATURE_HELP_GROUPS: ReadonlyArray<{
  title: string;
  ids: readonly FeatureHelpId[];
}> = [
  {
    title: "작업 흐름",
    ids: ["workbench", "threads", "taskRun", "targetDir", "agentPlan"],
  },
  {
    title: "안전과 증거",
    ids: ["approvals", "artifacts", "quality", "secrets"],
  },
  {
    title: "에이전트 구성",
    ids: [
      "settings",
      "agentProfiles",
      "pipelines",
      "remoteAgents",
      "mcpServers",
      "skills",
    ],
  },
  {
    title: "추천과 오케스트레이션",
    ids: ["capabilities", "learner", "instinct", "orchestration", "topology"],
  },
];

export const FEATURE_HELP_ORDER: readonly FeatureHelpId[] =
  FEATURE_HELP_GROUPS.flatMap((group) => group.ids);

export const getFeatureHelp = (id: FeatureHelpId): FeatureHelpEntry =>
  FEATURE_HELP[id];
