const EMBEDDED_ORCHESTRATION_PLAN_JSON_RE =
  /\n?<!-- orchestration-plan:json -->\s*```json\s*[\s\S]*?```\s*/g;

export const stripEmbeddedOrchestrationPlanJson = (
  content: string,
): string => content.replace(EMBEDDED_ORCHESTRATION_PLAN_JSON_RE, "").trimEnd();
