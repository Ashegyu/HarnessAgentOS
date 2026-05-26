import type { WorkerRole } from "@harness/core";

export interface WorkerRoleMetadata {
  label: string;
  shortLabel: string;
  description: string;
  whenToUse: string;
}

export const WORKER_ROLE_METADATA: Record<WorkerRole, WorkerRoleMetadata> = {
  planner: {
    label: "계획 수립자",
    shortLabel: "계획",
    description:
      "요구사항을 실행 가능한 단계, 위험, 검증 기준으로 분해합니다.",
    whenToUse:
      "범위가 애매하거나 여러 파일과 단계가 얽힌 작업을 시작할 때 사용합니다.",
  },
  coder: {
    label: "구현 담당자",
    shortLabel: "구현",
    description:
      "승인된 계획을 코드 변경 제안으로 옮기고, 변경 파일과 검증 근거를 남깁니다.",
    whenToUse:
      "기능 추가, 버그 수정, multi-file 변경처럼 file_write approval이 필요한 단계에 사용합니다.",
  },
  reviewer: {
    label: "정확성 리뷰어",
    shortLabel: "리뷰",
    description:
      "동작 회귀, 유지보수성, 누락된 테스트, 계약 불일치를 점검합니다.",
    whenToUse:
      "구현 후 최종 검토나 read-only 병렬 검토 단계에 사용합니다.",
  },
  tester: {
    label: "검증 담당자",
    shortLabel: "검증",
    description:
      "테스트 설계, 실행, 증거 정리를 통해 변경 경로가 실제로 안전한지 확인합니다.",
    whenToUse:
      "TDD, 회귀 테스트, 빌드 복구 후 재검증 단계에 사용합니다.",
  },
  orchestrator: {
    label: "오케스트레이터",
    shortLabel: "조정",
    description:
      "여러 worker의 책임 범위, 의존성, handoff, 승인 지점을 설계합니다.",
    whenToUse:
      "대형 작업을 여러 에이전트 흐름으로 나누거나 병렬 topology를 잡을 때 사용합니다.",
  },
  "security-reviewer": {
    label: "보안 리뷰어",
    shortLabel: "보안",
    description:
      "secret 노출, injection, path traversal, 승인 우회, 과도한 권한을 점검합니다.",
    whenToUse:
      "파일/쉘/네트워크/secret 경계가 바뀌거나 외부 입력을 다루는 작업에 사용합니다.",
  },
  "build-error-resolver": {
    label: "빌드 오류 해결자",
    shortLabel: "빌드",
    description:
      "빌드, 타입체크, lint, 테스트 실패의 첫 실제 원인을 추적하고 최소 수정안을 제안합니다.",
    whenToUse:
      "검증 명령이 실패했거나 실패 로그에서 원인 추적이 필요한 단계에 사용합니다.",
  },
  "refactor-cleaner": {
    label: "리팩터링 정리자",
    shortLabel: "정리",
    description:
      "동작을 유지하면서 중복, dead code, 과한 추상화, 유지보수 비용을 줄입니다.",
    whenToUse:
      "테스트로 보호된 범위에서 구조 개선이나 정리 작업을 진행할 때 사용합니다.",
  },
  "performance-reviewer": {
    label: "성능 리뷰어",
    shortLabel: "성능",
    description:
      "할당, 지연 시간, 반복 작업, 리소스 수명, benchmark 누락을 read-only로 점검합니다.",
    whenToUse:
      "핫패스, 반복 실행, 대용량 데이터, UI 반응성에 영향을 줄 수 있는 변경에 사용합니다.",
  },
  documenter: {
    label: "문서 작성자",
    shortLabel: "문서",
    description:
      "이전 에이전트의 분석, 계획, 검증 결과를 정리된 문서 산출물로 저장합니다.",
    whenToUse:
      "여러 worker의 결과를 HTML/문서 형태로 남기거나 다음 세션 handoff를 고정할 때 사용합니다.",
  },
};

export const roleLabel = (role: WorkerRole): string =>
  WORKER_ROLE_METADATA[role].label;

export const roleOptionLabel = (role: WorkerRole): string =>
  `${WORKER_ROLE_METADATA[role].label} (${role})`;
