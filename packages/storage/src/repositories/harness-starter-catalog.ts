import type { ApprovalActionType, HarnessDefinition, WorkerOutputContract } from "@harness/core";

interface StarterStep {
  id: string;
  title: string;
  role: string;
  instruction: string;
  output: WorkerOutputContract;
  actions: readonly ApprovalActionType[];
  dependsOn: readonly string[];
}

interface StarterWorkflow {
  key: string;
  name: string;
  englishName: string;
  summary: string;
  terms: readonly string[];
  steps: readonly StarterStep[];
}

const WRITE: readonly ApprovalActionType[] = ["file_write", "file_patch"];
const POLICY = "부수효과는 구체적인 proposedActions로 제안하고 승인된 Runner에서만 실행합니다. 실행 전에는 저장·테스트 성공을 주장하지 마세요. 실패 근거를 숨기지 말고 완료 범위와 미검증 범위를 구분하세요.";

// These are executable dependency graphs, not automatic retries or extra tasks.
const WORKFLOWS: readonly StarterWorkflow[] = [
  {
    key: "html_report", name: "HTML 분석 보고서 하네스", englishName: "HTML Analysis Report Harness",
    summary: "프로젝트 근거 조사 → HTML 파일 생성 → 저장 결과 검토", terms: ["HTML", "보고서", "파일로 저장"],
    steps: [
      { id: "inspect", title: "프로젝트 구조와 위험 조사", role: "planner", output: "plan", actions: [], dependsOn: [], instruction: "소스 구조, 실행 흐름, 설정과 검증 명령을 조사하세요. 각 판단에 파일 근거를 붙이고 추측을 구분하여 보고서 작성자에게 전달하세요." },
      { id: "write", title: "한국어 HTML 보고서 저장", role: "documenter", output: "diff_proposal", actions: WRITE, dependsOn: ["inspect"], instruction: "조사 근거로 읽기 쉬운 한국어 HTML 보고서를 만드세요. 사용자 지정 경로 또는 대상 폴더의 project-analysis.html에 실제 전체 내용을 담은 file_write를 제안하세요. 기존 파일 변경은 원본을 확인하고 file_patch를 사용하세요. 외부 스크립트 없이 본문을 이스케이프하세요." },
      { id: "review", title: "보고서 산출물 확인", role: "reviewer", output: "review", actions: [], dependsOn: ["write"], instruction: "승인된 파일 실행 근거와 실제 보고서 내용을 확인하세요. 파일 경로, 조사 범위, 미실행 검증을 최종 안내하고 저장 근거가 없으면 완료라고 주장하지 마세요." },
    ],
  },
  {
    key: "bugfix_verified", name: "버그 수정·회귀 검증 하네스", englishName: "Verified Bug Fix Harness",
    summary: "최소 수정안 → 회귀 테스트 실행 → 독립 리뷰", terms: ["버그 수정", "회귀 검증", "재현"],
    steps: [
      { id: "fix", title: "원인과 최소 수정", role: "coder", output: "diff_proposal", actions: WRITE, dependsOn: [], instruction: "재현 근거와 호출 경로를 분석하고 기존 변경을 보존한 최소 패치 및 회귀 테스트 파일을 제안하세요. 무관한 리팩터링은 제외하세요." },
      { id: "test", title: "관련 회귀 테스트", role: "tester", output: "test_result", actions: ["shell"], dependsOn: ["fix"], instruction: "승인·적용된 변경을 대상으로 가장 좁은 관련 테스트 명령을 shell proposedAction으로 제안하세요. 설치나 배포 명령은 제외하고 실제 종료 코드와 로그를 근거로 삼으세요." },
      { id: "review", title: "수정과 검증 근거 리뷰", role: "reviewer", output: "review", actions: [], dependsOn: ["test"], instruction: "원인 해결 여부와 회귀 테스트 로그를 독립 검토하세요. 실행 실패 또는 검증 누락이 있으면 성공으로 포장하지 말고 잔여 위험을 명시하세요." },
    ],
  },
  {
    key: "parallel_audit", name: "병렬 종합 감사 하네스", englishName: "Parallel Code Audit Harness",
    summary: "정확성·보안·성능을 병렬 검토한 뒤 근거를 통합하는 읽기 전용 감사", terms: ["종합 감사", "병렬 리뷰", "전체 검토"],
    steps: [
      { id: "correctness", title: "정확성·회귀 검토", role: "reviewer", output: "review", actions: [], dependsOn: [], instruction: "정확성, 상태 전이, 예외 처리와 회귀 위험만 검토하고 파일 위치와 재현 조건을 보고하세요." },
      { id: "security", title: "신뢰 경계·권한 검토", role: "security-reviewer", output: "review", actions: [], dependsOn: [], instruction: "입력 검증, 승인 경계, 경로 탈출과 비밀정보 취급을 읽기 전용으로 감사하세요. 악용 가능성을 코드 근거와 구분하세요." },
      { id: "performance", title: "CPU·메모리·동시성 검토", role: "performance-reviewer", output: "review", actions: [], dependsOn: [], instruction: "반복 비용, 할당, 동기화와 병렬 실행 경로를 정적으로 분석하세요. 측정되지 않은 효과를 수치로 단정하지 마세요." },
      { id: "synthesis", title: "감사 결과 통합", role: "reviewer", output: "review", actions: [], dependsOn: ["correctness", "security", "performance"], instruction: "세 검토 결과의 중복을 제거하고 충돌하는 근거를 비교하여 심각도와 실행 가능한 수정 방향을 정리하세요. 파일 수정은 수행하지 마세요." },
    ],
  },
  {
    key: "safe_refactor", name: "안전한 리팩터링 하네스", englishName: "Safe Refactoring Harness",
    summary: "동작 보존 계약 → 제한된 리팩터링 → 회귀 검증", terms: ["리팩터링", "중복 제거", "구조 개선"],
    steps: [
      { id: "contract", title: "보존할 동작 명세", role: "planner", output: "plan", actions: [], dependsOn: [], instruction: "변경 범위, 공개 인터페이스, 반드시 보존할 동작과 기존 사용자 변경을 기록하세요. 요청 외 설계 확장은 금지하세요." },
      { id: "refactor", title: "동작 보존 리팩터링", role: "refactor-cleaner", output: "diff_proposal", actions: WRITE, dependsOn: ["contract"], instruction: "명세 범위 안에서만 구조를 개선하는 최소 변경을 제안하세요. API, DB 스키마와 UX는 요청 없이 변경하지 마세요." },
      { id: "verify", title: "기존·회귀 테스트 검증", role: "tester", output: "test_result", actions: ["shell"], dependsOn: ["refactor"], instruction: "수정 적용 이후 기존 테스트와 관련 타입 검사를 위한 실제 shell 명령을 제안하세요. 실패나 미검증을 빠짐없이 정리하세요." },
    ],
  },
  {
    key: "api_contract_audit", name: "API·IPC 계약 감사 하네스", englishName: "API and IPC Contract Audit Harness",
    summary: "인터페이스·호출자 매핑 → 입력·응답·호환성 검토", terms: ["API 계약", "IPC", "호환성"],
    steps: [
      { id: "map", title: "호출 계약 추적", role: "planner", output: "plan", actions: [], dependsOn: [], instruction: "API 또는 IPC 인터페이스, 진입점, 서비스, 호출자와 테스트의 실제 연결을 추적하고 요청·응답·오류 계약을 정리하세요." },
      { id: "review", title: "계약·경계 검증", role: "reviewer", output: "review", actions: [], dependsOn: ["map"], instruction: "입력 검증 누락, 타입과 런타임 불일치, 호출자 호환성 및 권한 경계를 근거로 검토하세요. 새 서버나 엔드포인트를 만들지 말고 필요한 수정만 제안하세요." },
    ],
  },
  {
    key: "test_coverage_delivery", name: "테스트 보강·실행 하네스", englishName: "Test Coverage Delivery Harness",
    summary: "테스트 누락 분석 → 테스트 파일 생성 → 실제 실행", terms: ["테스트 보강", "커버리지", "테스트 추가"],
    steps: [
      { id: "gaps", title: "테스트 누락·경계값 분석", role: "planner", output: "plan", actions: [], dependsOn: [], instruction: "대상 기능의 정상·실패·경계 조건과 기존 테스트를 비교하여 가장 중요한 누락 시나리오를 정하세요. 실제 외부 CLI·유료 API는 mock 처리하세요." },
      { id: "author", title: "회귀 테스트 작성", role: "coder", output: "diff_proposal", actions: WRITE, dependsOn: ["gaps"], instruction: "프로젝트 테스트 규칙을 따르는 독립적인 테스트 파일을 생성·수정하는 액션을 제안하세요. 테스트 통과를 위해 제품 동작을 바꾸거나 단언을 약화하지 마세요." },
      { id: "execute", title: "새 테스트 실행", role: "tester", output: "test_result", actions: ["shell"], dependsOn: ["author"], instruction: "저장된 테스트 파일을 실행하는 최소 shell 액션을 제안하세요. 실제 결과와 실패 원인을 기록하고 커버리지 측정이 없으면 수치를 만들지 마세요." },
    ],
  },
  {
    key: "release_report", name: "릴리스 점검 보고서 하네스", englishName: "Release Verification Report Harness",
    summary: "빌드·테스트 점검 → 출시 판단 → 보고서 저장 (배포·커밋 없음)", terms: ["출시 점검", "릴리스 보고서", "배포 전 검증"],
    steps: [
      { id: "verify", title: "빌드·테스트 근거 수집", role: "tester", output: "test_result", actions: ["shell"], dependsOn: [], instruction: "프로젝트에 등록된 타입 검사·테스트·빌드 명령을 확인하고 승인용 shell 액션을 제안하세요. 배포, 설치, 커밋, 푸시와 삭제는 제외하세요." },
      { id: "decision", title: "출시 가능 여부 검토", role: "reviewer", output: "review", actions: [], dependsOn: ["verify"], instruction: "실행 로그, 잔여 변경, 롤백 준비와 검증 누락을 검토하여 출시 가능·보류 판단의 근거를 명시하세요. 자동 배포를 시작하지 마세요." },
      { id: "report", title: "점검 보고서 저장", role: "documenter", output: "diff_proposal", actions: WRITE, dependsOn: ["decision"], instruction: "실제 실행 명령·성공·실패·미검증 범위와 출시 판단을 한국어 Markdown 보고서로 저장하는 파일 액션을 제안하세요. 사용자 지정 경로가 없으면 release-readiness.md를 사용하세요." },
    ],
  },
  {
    key: "performance_evidence", name: "성능 측정·분석 보고서 하네스", englishName: "Performance Evidence Report Harness",
    summary: "승인된 측정 명령 → 성능 근거 분석 → 보고서 저장", terms: ["성능 측정", "벤치마크 보고서", "지연 분석"],
    steps: [
      { id: "measure", title: "재현 가능한 기준 측정", role: "tester", output: "test_result", actions: ["shell"], dependsOn: [], instruction: "기존 벤치마크 또는 사용자가 지정한 측정 명령을 shell 액션으로 제안하세요. 설치·운영 부하 테스트는 제외하고 환경·입력·반복 조건을 기록하세요. 측정 도구가 없으면 임의 수치를 만들지 말고 보류 사유를 보고하세요." },
      { id: "analyze", title: "측정 근거와 병목 해석", role: "performance-reviewer", output: "review", actions: [], dependsOn: ["measure"], instruction: "실제 측정 로그와 코드 경로를 연결하여 CPU·메모리·지연 병목 후보를 분석하세요. 인과관계와 추정을 구분하고 개선안 및 재측정 조건을 제시하세요." },
      { id: "report", title: "성능 분석 보고서 저장", role: "documenter", output: "diff_proposal", actions: WRITE, dependsOn: ["analyze"], instruction: "측정 조건, 원시 결과 요약, 병목 근거, 제안과 한계를 performance-analysis.md 또는 지정 경로에 저장하는 파일 액션을 제안하세요. 실행되지 않은 측정을 성공으로 쓰지 마세요." },
    ],
  },
];

/** Known v1 templates are upgraded only after a full snapshot comparison by the repository. */
export const upgradeLegacyStarter = (legacy: HarnessDefinition): HarnessDefinition => {
  const template = structuredClone(legacy);
  const step = template.workflows[0]!.steps[0]!;
  let actions = [...step.allowedActions];
  let instruction = step.instruction;
  let roleHint = step.roleHint;
  if (actions.includes("file_patch")) actions = ["file_write", ...actions];
  if (template.id === "harness_seed_performance") {
    actions = [];
    instruction = "제공된 측정 로그와 소스 근거로 CPU·메모리·지연 비용을 분석하세요. 측정이 없으면 정적 후보와 미검증 범위를 명시하세요. 실제 측정은 성능 측정·분석 보고서 하네스를 사용하세요.";
    template.overview = { ...template.overview, summary: "코드와 기존 측정 근거를 검토하여 성능 개선 후보를 제안합니다." };
  }
  if (template.id === "harness_seed_database_migration") actions = [];
  if (template.id === "harness_seed_release_readiness") actions = ["shell"];
  if (template.id === "harness_seed_ui_polish") roleHint = "coder";
  template.version = "1.1.0";
  template.source = { ...template.source, files: template.source.files.map(file => ({
    ...file, sha256: `builtin-${template.id}-v2`, parserVersion: "harness-starter-catalog-v2",
  })) };
  template.validation = { ...template.validation, adapterVersion: "harness-starter-catalog-v2" };
  template.skills = template.skills.map(skill => ({ ...skill, description: template.overview.summary,
    rawFrontmatter: { ...skill.rawFrontmatter, generatedBy: "harness-starter-catalog-v2" } }));
  template.agents = template.agents.map(agent => ({ ...agent, roleHint, responsibilities: [instruction] }));
  template.workflows = template.workflows.map(workflow => ({ ...workflow,
    description: template.overview.summary,
    phases: workflow.phases.map(phase => ({ ...phase, summary: instruction })),
    steps: [{ ...step, roleHint, instruction, allowedActions: actions }],
  }));
  return template;
};

export const additionalStarterDefinitions = (base: HarnessDefinition): HarnessDefinition[] => WORKFLOWS.map(spec => {
  const id = `harness_seed_${spec.key}`;
  const workflowId = `${id}_workflow`;
  const skillId = `${id}_skill`;
  const sourceFile = `builtin/${id}/harness.json`;
  const stepId = (key: string): string => `${id}_${key}`;
  const roles = [...new Set(spec.steps.map(step => step.role))];
  const roleNames: Record<string, string> = { planner: "분석·계획자", coder: "개발자", reviewer: "검토자", tester: "테스트 실행자", documenter: "문서 작성자", "refactor-cleaner": "리팩터링 개발자", "security-reviewer": "보안 검토자", "performance-reviewer": "성능 검토자" };
  const steps = spec.steps.map(step => ({ id: stepId(step.id), title: step.title,
    agentRef: step.role, roleHint: step.role, phaseId: "execution", instruction: `${step.instruction}\n\n${POLICY}`,
    dependsOn: step.dependsOn.map(stepId), artifactContracts: [], allowedActions: [...step.actions],
    outputContract: step.output, sourceRef: { relativePath: sourceFile } }));
  return { ...base, id, name: spec.name, version: "1.1.0",
    source: { ...base.source, rootDir: `harness://starter/${id}`, files: [{ relativePath: sourceFile, kind: "manifest", sha256: `builtin-${id}-v2`, parserVersion: "harness-starter-catalog-v2" }] },
    overview: { title: spec.name, summary: spec.summary, usage: "저장된 에이전트 연결을 선택하고 요청을 입력하세요. 독립적인 읽기 전용 단계만 병렬 실행합니다.", outputPolicy: POLICY },
    agents: roles.map(role => ({ id: role, name: roleNames[role] ?? role, roleHint: role,
      description: spec.summary, sourceFile, persona: `${spec.name}의 ${roleNames[role] ?? role}입니다.`,
      responsibilities: spec.steps.filter(step => step.role === role).map(step => step.instruction),
      providerHint: "auto", requiredCapabilities: [] })),
    skills: [{ id: skillId, name: spec.name.replace(/ 하네스$/, ""), description: spec.summary,
      triggerTerms: [...spec.terms], negativeTriggerTerms: ["무승인 실행", "자동 배포"], sourceFile,
      workflowRefs: [workflowId], relatedSkillRefs: [], rawFrontmatter: { generatedBy: "harness-starter-catalog-v2",
        harnessLocalization: { key: `builtin.harness.${spec.key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`, en: { name: spec.englishName }, ko: { name: spec.name } } } }],
    workflows: [{ id: workflowId, skillId, name: spec.name.replace(/ 하네스$/, ""),
      mode: spec.key === "parallel_audit" ? "agent-team" : "sequential", description: spec.summary, sourceFile,
      phases: [{ id: "execution", title: "수행 및 근거 확인", owner: "agent", summary: spec.summary }], steps,
      handoffPolicy: { mode: "structured_handoff", routes: steps.flatMap(step => step.dependsOn.map(fromStepId => ({ fromStepId, toStepId: step.id, summary: "승인 실행 및 이전 단계의 근거 전달" }))), requiredPayload: "harness_worker_handoff_v1", fallback: "pause_for_review" },
      failurePolicy: { defaultMode: "pause_for_review", maxAttempts: 1, rules: [] },
      testScenarios: [{ id: `${id}_acceptance`, title: "근거와 승인 경계 확인", prompt: spec.summary,
        expected: ["모든 역할에 유효한 AgentProfile 연결", "승인 전 부수효과 없음", "선행 단계 완료 후 종속 단계 수행", "실제 실행 근거와 미검증 범위 구분"] }],
      parseConfidence: "high" }],
    validation: { ...base.validation, adapterVersion: "harness-starter-catalog-v2" },
  };
});
