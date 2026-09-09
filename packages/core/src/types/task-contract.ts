import type { ApprovalActionType } from "./approval.ts";

export const TASK_INTENTS = ["answer", "review", "diagnose", "change", "research", "unspecified"] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

/** Immutable within a TaskRun; changing authorization requires a new run. */
export interface TaskContract {
  revision: 1;
  origin: "user_mode" | "request_rules" | "legacy";
  intent: TaskIntent;
  deliverable: string;
  constraints: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: string[];
  authorization: { mode: "read_only" | "approval_required" };
  externalSearch: "allowed" | "forbidden";
  freshness: "not_requested" | "external_sources";
}

export const isTaskIntent = (value: unknown): value is TaskIntent =>
  typeof value === "string" && (TASK_INTENTS as readonly string[]).includes(value);

// Only classify the request itself; quoted examples and code are input data.
const requestInstructions = (text: string): string => text
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/^\s*>.*$/gm, " ")
  .replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, " ");

export const buildTaskContract = (input: {
  userRequest: string;
  intent?: TaskIntent;
  legacy?: boolean;
}): TaskContract => {
  if (input.intent !== undefined && !isTaskIntent(input.intent)) {
    throw new Error("Invalid task intent");
  }
  const text = requestInstructions(input.userRequest);
  const noSearch = /(?:검색|브라우징)\s*(?:하지\s*(?:마|말)|금지)|\b(?:do not|don't|no|without)\s+(?:search\w*|brows\w*)\b/i.test(text);
  const noChanges = /(?:수정|변경|편집|작성|저장|실행)\s*(?:하지\s*(?:마|말)|금지)|읽기\s*전용|\bread[- ]only\b|\b(?:do not|don't|without)\s+(?:edit|modify|change|write|save|execute)\b/i.test(text);
  const changeRequested = /(?:수정|구현|추가|생성|고쳐|바꿔|작성|저장|삭제|실행)(?:해|줘|하|을|를)|\b(?:fix|implement|add|create|update|edit|save|delete|run)\b/i.test(text);
  const diagnose = /원인|진단|\bdiagnos(?:e|is)\b|\broot cause\b/i.test(text);
  const review = /검토|리뷰|검사|\breview\b|\baudit\b/i.test(text);
  const research = /조사|찾아|검색|\bresearch\b|\blook up\b/i.test(text);
  const answer = /번역|요약|설명|알려|\b(?:translate|summarize|explain)\b/i.test(text);
  const inferred: TaskIntent = !noChanges && changeRequested ? "change"
    : diagnose ? "diagnose" : review ? "review" : research ? "research"
    : answer ? "answer" : noChanges ? "review" : "unspecified";
  const intent = input.intent ?? inferred;
  const readOnly = noChanges || ["answer", "review", "diagnose", "research"].includes(intent);
  return {
    revision: 1,
    origin: input.legacy ? "legacy" : input.intent ? "user_mode" : "request_rules",
    intent,
    deliverable: input.userRequest,
    constraints: [
      ...(readOnly ? ["작업 파일과 외부 데이터를 변경하지 않는다."] : []),
      ...(noSearch ? ["외부 검색을 하지 않고 제공된 자료와 로컬 근거만 사용한다."] : []),
    ],
    assumptions: input.intent || inferred !== "unspecified" ? [] : ["작업 목적이 명확하지 않아 기존 승인 절차를 적용한다."],
    acceptanceCriteria: ["사용자가 요청한 결과를 제공한다.", "실행하지 않은 검증을 완료했다고 표시하지 않는다."],
    evidenceRequirements: intent === "change" ? ["변경 내용", "관련 검증 결과"]
      : intent === "review" || intent === "diagnose" ? ["검토한 자료의 위치와 근거"]
      : intent === "research" ? ["자료 출처와 확인 시점"] : ["사용자 입력"],
    authorization: { mode: readOnly ? "read_only" : "approval_required" },
    externalSearch: noSearch ? "forbidden" : "allowed",
    freshness: intent === "research" && !noSearch ? "external_sources" : "not_requested",
  };
};

export const taskContractFor = (task: { userRequest: string; contract?: TaskContract }): TaskContract =>
  task.contract ?? buildTaskContract({ userRequest: task.userRequest, legacy: true });

/** The composer and host must never silently discard an explicit execution route. */
export const taskRouteConflict = (contract: TaskContract, hasSelectedRoute: boolean): string | null => {
  if (!hasSelectedRoute) return null;
  if (contract.authorization.mode === "read_only") {
    return "선택한 하네스·파이프라인과 읽기 전용 작업 목적이 충돌합니다. 일반 답변을 원하면 선택을 해제하세요. 파일 저장이 목적이면 변경 작업으로 요청하세요.";
  }
  if (contract.externalSearch === "forbidden") {
    return "선택한 하네스·파이프라인은 검색 금지 조건을 보장하지 못합니다. 선택을 해제하면 제공된 자료와 로컬 근거로 일반 작업을 진행합니다.";
  }
  return null;
};

export const taskContractBlocksAction = (contract: TaskContract, action: ApprovalActionType): boolean =>
  (contract.authorization.mode === "read_only" && action !== "model_use" && action !== "capability_use") ||
  // Host shell/scripts and remote workers have no per-call network sandbox yet.
  (contract.externalSearch === "forbidden" && ["network", "shell", "dependency_install", "git_commit", "skill_script", "orchestration_plan"].includes(action));

export const isTaskContract = (value: unknown): value is TaskContract => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const auth = v.authorization as Record<string, unknown> | undefined;
  return v.revision === 1 && isTaskIntent(v.intent) && typeof v.deliverable === "string" &&
    ["user_mode", "request_rules", "legacy"].includes(String(v.origin)) &&
    ["not_requested", "external_sources"].includes(String(v.freshness)) &&
    ["allowed", "forbidden"].includes(String(v.externalSearch)) &&
    [v.constraints, v.assumptions, v.acceptanceCriteria, v.evidenceRequirements].every(
      (a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
    ) && (auth?.mode === "read_only" || auth?.mode === "approval_required");
};
