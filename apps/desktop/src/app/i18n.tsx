import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UiLanguage } from "@harness/core";

export type Locale = UiLanguage;

export const UI_MESSAGES = {
  "cli.check": { ko: "CLI 다시 확인", en: "Recheck CLI" },
  "cli.checking": { ko: "CLI 연결 확인 중…", en: "Checking CLI connection…" },
  "cli.required": { ko: "CLI 연결을 확인한 뒤 작업을 시작합니다. 연결 전에는 빈 계획이나 파일 승인을 만들지 않습니다.", en: "Connect the CLI to start. No empty plans or file approvals are created while disconnected." },
  "cli.unavailable": { ko: "CLI 연결을 확인할 수 없습니다. 입력은 보존했습니다. CLI 설치·실행 경로를 확인한 뒤 다시 시도하세요.", en: "The CLI is unavailable. Your input is preserved. Check the CLI installation and executable path, then try again." },
  "cli.checkFailed": { ko: "CLI 연결 확인에 실패했습니다. 입력은 보존했습니다. 다시 확인해 주세요.", en: "The CLI connection check failed. Your input is preserved. Please recheck." },
  "answer.copy": { ko: "답변 복사", en: "Copy answer" },
  "answer.copied": { ko: "복사됨", en: "Copied" },
  "answer.copying": { ko: "복사 중…", en: "Copying…" },
  "answer.copyHint": {
    ko: "줄바꿈과 코드 블록을 포함한 답변 원문 복사",
    en: "Copy the original answer, including line breaks and code blocks",
  },
  "answer.copyFailed": {
    ko: "복사하지 못했습니다. 다시 시도하거나 답변을 선택해 Ctrl+C로 복사하세요.",
    en: "Could not copy. Try again or select the answer and press Ctrl+C.",
  },
  "settings.parallelWorkers": {
    ko: "최대 병렬 AI 작업 수",
    en: "Maximum parallel AI workers",
  },
  "settings.parallelWorkersHint": {
    ko: "독립 작업을 동시에 실행할 최대 개수입니다. 직접 쓰기 모드에서는 안전을 위해 직렬로 실행됩니다.",
    en: "Maximum independent workers to run at once. Direct-write mode remains serial for safety.",
  },
  "parallel.running": {
    ko: "병렬 실행 중 {running}/{total}",
    en: "Running in parallel {running}/{total}",
  },
  "parallel.queued": {
    ko: "대기 중 {queued}",
    en: "Queued {queued}",
  },
} as const;

export type UiMessageKey = keyof typeof UI_MESSAGES;

export const translateUiKey = (
  key: UiMessageKey,
  locale: Locale,
  values: Readonly<Record<string, string | number>> = {},
): string => {
  const template = UI_MESSAGES[key][locale];
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
};

const EN_KO = {
  "AI response": "AI 답변",
  "Approve and run": "승인 후 실행",
  "Arguments must be a JSON string array.": "인수는 JSON 문자열 배열이어야 합니다.",
  "Arguments (optional JSON array; empty means shell command)": "인수 (선택, JSON 배열; 비우면 셸 명령으로 실행)",
  "Confirm the risk and current action details.": "위험 안내와 현재 파일/명령 내용을 확인해 주세요.",
  "Running — editing and duplicate execution are locked.": "실행 중 — 수정 및 중복 실행 잠김",
  "Review required — no automatic retry. Inspect the result before creating a new approval.": "실행 결과 확인 필요 — 자동 재시도 없음. 실제 파일/명령 결과를 확인한 뒤 새 승인을 생성하세요.",
  "Completed — this approval cannot be reused.": "실행 완료 — 승인 재사용 불가",
  "I understand this command has no OS sandbox and can access files outside the task folder and the network.": "이 명령은 OS 샌드박스 없이 실행되어 작업 폴더 밖의 파일과 네트워크에도 접근할 수 있음을 확인했습니다.",
  "I reviewed the displayed file details and agree to move this single file to the Recycle Bin.": "표시된 파일 정보와 경로를 확인했으며, 이 파일 하나를 휴지통으로 이동하는 데 동의합니다.",
  "I reviewed the revised action.": "변경된 내용을 다시 확인했습니다.",
  "Save details to inspect the file size, modification time, and hash before approval.": "세부 지정에서 저장하여 삭제 파일의 크기·수정 시각·해시를 먼저 확인하세요.",
  "Single-file recycle only; review and approve after saving.": "단일 파일만 휴지통으로 이동합니다. 저장 후 파일 정보를 확인하고 별도로 승인하세요.",
  "Confirm individual approval risk": "개별 승인 위험 확인",
  file_delete: "파일 휴지통 이동",
  "App navigation": "앱 탐색",
  "Thread sidebar": "스레드 사이드바",
  "Open settings": "설정 열기",
  "New thread": "새 스레드",
  Threads: "스레드",
  THREADS: "스레드",
  Settings: "설정",
  Plan: "계획",
  "Agent Graph": "에이전트 그래프",
  Timeline: "타임라인",
  Files: "파일",
  Quality: "품질",
  Orchestration: "오케스트레이션",
  Cost: "비용",
  Decisions: "결정",
  Guide: "안내",
  General: "일반",
  Agents: "에이전트",
  "Remote Agents": "원격 에이전트",
  Pipelines: "파이프라인",
  Evals: "평가",
  Skills: "스킬",
  Harnesses: "하네스",
  Secrets: "보안 정보",
  Budget: "예산",
  "Response validation": "응답 검증",
  "Model execution is blocked. It will not retry automatically.":
    "모델 실행이 차단되었습니다. 자동으로 재시도하지 않습니다.",
  "Check the selected profile's cost limits in Settings → Agents. This CLI cannot guarantee a USD cap. Only you can change the limit; after updating settings, use the button below to run again.":
    "설정 → 에이전트에서 선택한 프로필의 비용 한도를 확인하세요. 현재 CLI는 USD 상한을 보장하지 못합니다. 제한 변경은 사용자가 결정해야 하며, 설정을 수정한 뒤 아래 버튼으로 다시 실행할 수 있습니다.",
  "Read-only tasks validate response delivery and request scope. No build, tests, or additional AI review will be run.":
    "읽기 전용 작업은 응답 생성과 요청 범위를 확인합니다. 빌드·테스트를 실행하거나 별도 AI 검토를 추가하지 않습니다.",
  "The response is ready. Its sources and content still need your review.":
    "응답 생성은 끝났습니다. 인용 자료와 내용의 타당성은 사용자 확인이 필요합니다.",
  "No actual change evidence supports the change request.":
    "수정 요청에 대응하는 실제 변경 근거가 없습니다.",
  "Change evidence was found in a read-only task.":
    "읽기 전용 요청에서 변경 근거가 발견되었습니다.",
  "No final response evidence is linked to the latest successful model invocation.":
    "성공한 최신 모델 호출에 연결된 최종 응답 근거가 없습니다.",
  "Leave blank for no USD cap. With a cap, calls with unknown cost are blocked before execution. CLI billing mode and pre-call cost are currently unverified.":
    "비워두면 USD 제한을 적용하지 않습니다. 한도를 설정하면 비용 미확인 호출은 실행 전에 차단됩니다. 현재 CLI의 과금 방식과 호출 전 비용은 미확인입니다.",
  Activity: "활동",
  Diagnostics: "진단",
  Backup: "백업",
  Shortcuts: "단축키",
  Provider: "제공자",
  Model: "모델",
  "Reasoning effort": "추론 수준",
  "Task purpose": "작업 목적",
  "Automatic intent": "자동 판단",
  "Answer / summary": "답변 / 요약",
  "Review only": "검토만",
  "Diagnose only": "원인 분석만",
  "Change / implement": "수정 / 구현",
  "Research sources": "자료 조사",
  "Read-only": "읽기 전용",
  "No external search — external tools and host commands will not run.":
    "외부 검색 금지 — 외부 도구와 Host 명령은 실행하지 않습니다.",
  "Save this read-only task. Connect the CLI to receive an answer.":
    "읽기 전용 작업을 저장합니다. 답변을 받으려면 CLI 연결이 필요합니다.",
  "Read-only — use regular chat without file changes or pipeline execution.":
    "읽기 전용 — 파일 변경과 파이프라인 실행 없이 일반 채팅으로 처리합니다.",
  "Astra is for the hardest tasks, Sol for high performance, Terra for balance, and Luna for fast, economical runs.":
    "Astra는 가장 복잡한 작업, Sol은 고성능, Terra는 균형형, Luna는 빠르고 경제적인 실행에 적합합니다.",
  "Choose from none through max. For GPT-6 Astra, none runs as the lowest supported effort, low.":
    "none부터 max까지 선택할 수 있습니다. GPT-6 Astra에서 none은 지원되는 최저 단계인 low로 실행됩니다.",
  "Choose the Codex model for this profile. GPT-6 Astra is supported.":
    "이 프로필에서 사용할 Codex 모델을 선택합니다. GPT-6 Astra도 지원합니다.",
  "Select a supported Codex model":
    "지원되는 Codex 모델을 선택해야 합니다",
  "Hard timeout (ms)": "최대 제한 시간 (ms)",
  "Idle timeout (ms)": "유휴 제한 시간 (ms)",
  "Context depth": "컨텍스트 깊이",
  "Agent Orchestration (experimental)": "에이전트 오케스트레이션 (실험적)",
  "A2A Remote Agents": "A2A 원격 에이전트",
  "Harness Packages": "하네스 패키지",
  "Harness native": "하네스 네이티브",
  "Agent Profiles": "에이전트 프로필",
  "MCP servers": "MCP 서버",
  "Skill sources": "스킬 소스",
  Endpoint: "엔드포인트",
  "+ New Endpoint": "+ 새 엔드포인트",
  "+ 새 Endpoint": "+ 새 엔드포인트",
  "Base URL": "기본 URL",
  "Agent Card URL": "에이전트 카드 URL",
  Transport: "전송 방식",
  "Auth secret ref": "인증 보안정보 참조",
  "Agent Card": "에이전트 카드",
  Agent: "에이전트",
  Version: "버전",
  Modes: "모드",
  "Code Review Agent": "코드 리뷰 에이전트",
  "Test Automation Agent": "테스트 자동화 에이전트",
  "Security Audit Agent": "보안 감사 에이전트",
  "Performance Agent": "성능 분석 에이전트",
  "Frontend UX Agent": "프론트엔드 UX 에이전트",
  "Backend API Agent": "백엔드 API 에이전트",
  "Database Agent": "데이터베이스 에이전트",
  "Documentation Agent": "문서화 에이전트",
  "Release Agent": "릴리스 에이전트",
  "Research Agent": "리서치 에이전트",
  "Feature Delivery Harness": "기능 개발 하네스",
  "Bug Investigation Harness": "버그 조사 하네스",
  "Code Review Harness": "코드 리뷰 하네스",
  "Security Hardening Harness": "보안 강화 하네스",
  "Performance Optimization Harness": "성능 최적화 하네스",
  "Test Automation Harness": "테스트 자동화 하네스",
  "Documentation Harness": "문서화 하네스",
  "Database Migration Harness": "데이터베이스 마이그레이션 하네스",
  "Release Readiness Harness": "릴리스 준비 하네스",
  "UI UX Polish Harness": "UI/UX 개선 하네스",
  "Code Review": "코드 리뷰",
  "Test Automation": "테스트 자동화",
  "Security Audit": "보안 감사",
  "Performance Analysis": "성능 분석",
  "Frontend UX": "프론트엔드 UX",
  "Backend API": "백엔드 API",
  "Database Engineering": "데이터베이스 엔지니어링",
  Documentation: "문서화",
  "Release Readiness": "릴리스 준비",
  "Technical Research": "기술 조사",
  "Reviews changes for correctness, maintainability, and regression risk.": "변경 사항의 정확성, 유지보수성, 회귀 위험을 검토합니다.",
  "Designs and runs focused unit, integration, and end-to-end tests.": "단위·통합·E2E 테스트를 설계하고 실행합니다.",
  "Finds trust-boundary, secret-handling, and input-validation risks.": "신뢰 경계, 보안정보 처리, 입력 검증 위험을 찾습니다.",
  "Profiles latency, CPU, memory, and repeated work before proposing changes.": "변경을 제안하기 전에 지연 시간, CPU, 메모리와 반복 작업을 측정합니다.",
  "Builds accessible, responsive, and visually coherent user interfaces.": "접근성과 반응성을 갖춘 일관된 사용자 인터페이스를 만듭니다.",
  "Designs service boundaries, APIs, validation, and failure handling.": "서비스 경계, API, 검증과 오류 처리를 설계합니다.",
  "Reviews schemas, queries, migrations, and transactional correctness.": "스키마, 쿼리, 마이그레이션과 트랜잭션 정확성을 검토합니다.",
  "Turns implementation details into concise operator and developer documentation.": "구현 세부사항을 간결한 운영자·개발자 문서로 정리합니다.",
  "Checks release readiness, packaging, changelogs, and rollback evidence.": "릴리스 준비 상태, 패키징, 변경 기록과 롤백 근거를 점검합니다.",
  "Collects primary-source evidence and compares implementation options.": "1차 출처 근거를 수집하고 구현 선택지를 비교합니다.",
  "Plan, implement, and verify a focused product feature.": "제품 기능을 계획하고 구현한 뒤 검증합니다.",
  "Reproduce a defect, isolate its cause, and prepare a regression-safe fix.": "결함을 재현하고 원인을 분리하여 회귀에 안전한 수정안을 준비합니다.",
  "Review changes for correctness, maintainability, and regression risk.": "변경 사항의 정확성, 유지보수성, 회귀 위험을 검토합니다.",
  "Audit trust boundaries and propose practical security hardening.": "신뢰 경계를 감사하고 실용적인 보안 강화 방안을 제안합니다.",
  "Measure hot paths before proposing targeted performance changes.": "병목 구간을 측정한 뒤 목표가 분명한 성능 변경을 제안합니다.",
  "Create focused automated coverage for important user and service flows.": "중요한 사용자 및 서비스 흐름에 집중된 자동화 테스트를 만듭니다.",
  "Produce accurate developer and operator documentation from the live implementation.": "실제 구현을 바탕으로 정확한 개발자·운영자 문서를 작성합니다.",
  "Plan safe, idempotent schema and data migrations with rollback evidence.": "롤백 근거가 있는 안전하고 멱등적인 스키마·데이터 마이그레이션을 계획합니다.",
  "Verify build, packaging, release notes, and rollback readiness.": "빌드, 패키징, 릴리스 노트와 롤백 준비 상태를 검증합니다.",
  "Review visual consistency, accessibility, responsive behavior, and interaction quality.": "시각적 일관성, 접근성, 반응형 동작과 상호작용 품질을 검토합니다.",
  "Built-in starter. Bind the agent before creating a pipeline.": "내장 시작 템플릿입니다. 파이프라인을 만들기 전에 에이전트를 연결하세요.",
  "Every side effect remains approval-gated.": "모든 부수효과는 승인 절차를 거쳐야 합니다.",
  "System Diagnostics": "시스템 진단",
  "Keyboard Shortcuts": "키보드 단축키",
  Scope: "범위",
  Keys: "키",
  Action: "동작",
  Notifications: "알림",
  "Internal handoff": "내부 인계",
  Learning: "학습",
  Preview: "미리보기",
  "Health check": "상태 확인",
  "Approval Batch": "승인 묶음",
  Target: "대상",
  Checkpoint: "체크포인트",
  Approvals: "승인",
  "Pipeline Draft": "파이프라인 초안",
  "Binding readiness": "바인딩 준비 상태",
  "Node settings": "노드 설정",
  "Visual Pipeline Builder": "시각적 파이프라인 편집기",
  "Output Contract": "출력 계약",
  "Model breakdown": "모델별 내역",
  "Token trend": "토큰 추이",
  "Total tokens": "전체 토큰",
  "Trace count": "추적 수",
  "Pass rate": "통과율",
  "Top models": "주요 모델",
  "Mark done": "완료 처리",
  "Mark ready for review": "검토 준비 완료",
  "Retry last action": "마지막 동작 다시 시도",
  "Request refinement": "개선 요청",
  "Shadow preview": "섀도 미리보기",
  "Save Template": "템플릿 저장",
  "Propose Write": "쓰기 제안",
  "No threads": "스레드 없음",
  "Handle planning, approval, execution, and verification safely in one flow.":
    "계획부터 승인, 실행, 검증까지 한 흐름 안에서 안전하게 다루세요.",
  "Runtime ready": "런타임 준비됨",
  "Create a new thread": "새 스레드 만들기",
  "New task": "새 작업",
  "Create new task": "새 작업 만들기",
  "Start your first task": "첫 작업을 시작하세요",
  "Manage each thread with its own target folder and execution flow.":
    "스레드마다 대상 폴더와 실행 흐름을 분리해 관리할 수 있습니다.",
  " to get started": "으로 바로 시작",
  "No validation issues.": "검증 문제가 없습니다.",
  Identity: "식별 정보",
  Workflow: "워크플로",
  "Binding set": "바인딩 세트",
  Steps: "단계",
  Mode: "모드",
  Confidence: "신뢰도",
  Owner: "담당자",
  Depends: "의존 대상",
  Artifacts: "산출물",
  Output: "출력",
  Instruction: "지시사항",
  Title: "제목",
  Role: "역할",
  Actions: "동작",
  "Local CLI": "로컬 CLI",
  Unbound: "연결 안 됨",
  "Manual repair": "수동 복구",
  Note: "참고",
  "No parsed workflows.": "분석된 워크플로가 없습니다.",
  "No agent refs in this workflow.": "이 워크플로에 에이전트 참조가 없습니다.",
  "No skills imported.": "가져온 스킬이 없습니다.",
  "No agents imported.": "가져온 에이전트가 없습니다.",
  "Ready for pipeline preview.": "파이프라인 미리보기를 실행할 수 있습니다.",
  "Search commands...": "명령 검색...",
  Close: "닫기",
  Cancel: "취소",
  Save: "저장",
  Create: "생성",
  Delete: "삭제",
  Refresh: "새로고침",
  Retry: "다시 시도",
  Loading: "불러오는 중",
  Enabled: "활성화됨",
  Disabled: "비활성화됨",
  Active: "활성",
  Inactive: "비활성",
  Trusted: "신뢰됨",
  "Not trusted": "신뢰 안 됨",
  valid: "유효",
  invalid: "유효하지 않음",
  warning: "경고",
  error: "오류",
  pending: "대기 중",
  approved: "승인됨",
  rejected: "거절됨",
  running: "실행 중",
  completed: "완료됨",
  failed: "실패",
  queued: "대기열",
  paused: "일시 정지",
  cancelled: "취소됨",
  off: "꺼짐",
} as const;

const KO_EN = Object.fromEntries(
  Object.entries(EN_KO).map(([english, korean]) => [korean, english]),
) as Record<string, string>;

export const normalizeLocale = (value: unknown): Locale =>
  value === "en" ? "en" : "ko";

const translateKnown = (value: string, locale: Locale): string => {
  const catalog: Record<string, string> = locale === "ko" ? EN_KO : KO_EN;
  return catalog[value] ?? value;
};

export const translateUiText = (value: string, locale: Locale): string => {
  const match = /^(\s*)(.*?)(\s*)$/s.exec(value);
  if (!match) return value;
  const [, before, content, after] = match;
  if (!content) return value;
  return `${before}${translateKnown(content, locale)}${after}`;
};

export const translateUiAttribute = translateUiText;

const SKIP_ELEMENTS = new Set(["CODE", "PRE", "KBD", "SAMP", "SCRIPT", "STYLE", "TEXTAREA"]);
// Accessible names must switch with the visible locale as well. E2E selectors
// use stable data-testid/roles rather than relying on English aria-label text.
export const translatedUiAttributes = [
  "title",
  "placeholder",
  "data-tooltip",
  "aria-label",
] as const;

const translateElement = (root: ParentNode, locale: Locale): void => {
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent || SKIP_ELEMENTS.has(parent.tagName) || parent.closest("[data-i18n-skip]")) return;
      const translated = translateUiText(node.nodeValue ?? "", locale);
      if (translated !== node.nodeValue) node.nodeValue = translated;
      return;
    }
    if (!(node instanceof Element)) return;
    if (SKIP_ELEMENTS.has(node.tagName) || node.closest("[data-i18n-skip]")) return;
    for (const attribute of translatedUiAttributes) {
      const current = node.getAttribute(attribute);
      if (current !== null) {
        const translated = translateUiAttribute(current, locale);
        if (translated !== current) node.setAttribute(attribute, translated);
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  toggleLocale: () => Promise<void>;
  t: (value: string) => string;
  tk: (
    key: UiMessageKey,
    values?: Readonly<Record<string, string | number>>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [locale, setLocaleState] = useState<Locale>("ko");

  useEffect(() => {
    let cancelled = false;
    void window.harness.settings.get().then((settings) => {
      if (!cancelled) setLocaleState(normalizeLocale(settings.ui?.language));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    translateElement(document.body, locale);
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      for (const record of records) {
        if (record.type === "characterData" && record.target.parentNode) {
          translateElement(record.target.parentNode, locale);
        }
        for (const node of record.addedNodes) {
          if (node.parentNode) translateElement(node.parentNode, locale);
        }
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [locale]);

  const setLocale = useCallback(async (nextLocale: Locale): Promise<void> => {
    const normalized = normalizeLocale(nextLocale);
    const current = await window.harness.settings.get();
    await window.harness.settings.update({ ...current, ui: { language: normalized } });
    setLocaleState(normalized);
  }, []);

  const toggleLocale = useCallback(async (): Promise<void> => {
    await setLocale(locale === "ko" ? "en" : "ko");
  }, [locale, setLocale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    toggleLocale,
    t: (text) => translateUiText(text, locale),
    tk: (key, values) => translateUiKey(key, locale, values),
  }), [locale, setLocale, toggleLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nContextValue => {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
};
