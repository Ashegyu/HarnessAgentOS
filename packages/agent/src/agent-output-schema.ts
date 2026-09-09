import { AGENT_INVALID_OUTPUT, type AgentPlanOutput, type TaskContract } from "@harness/core";
import { AgentCliError } from "./model-cli-errors.ts";

export type AgentOutputContract = Pick<TaskContract, "revision" | "intent" | "authorization" | "externalSearch">;

// Only host-built schemas enter the validator. This intentionally small subset
// shares one definition between the CLI constraint and the host trust boundary.
type Schema =
  | { type: "string"; enum?: readonly string[]; pattern?: string }
  | { type: "integer"; enum: readonly number[] }
  | { type: "null" }
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false }
  | { type: "array"; items: Schema; maxItems?: number }
  | { anyOf: Schema[] };

const text: Schema = { type: "string" };
const nonempty: Schema = { type: "string", pattern: "\\S" };
const strings: Schema = { type: "array", items: text };
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

export const buildAgentOutputSchema = (contract: AgentOutputContract): Schema => {
  const actions: Schema[] = [
    object({ type: { type: "string", enum: ["file_patch"] }, path: nonempty, patch: nonempty, rationale: text }),
    object({ type: { type: "string", enum: ["file_delete"] }, path: nonempty, rationale: text }),
    object({ type: { type: "string", enum: ["file_write"] }, path: nonempty,
      before: { anyOf: [text, { type: "null" }] }, after: text, rationale: text }),
  ];
  if (contract.externalSearch !== "forbidden") {
    actions.push(object({ type: { type: "string", enum: ["shell"] }, command: nonempty, args: strings, rationale: text }));
  }
  const readOnly = contract.authorization.mode === "read_only";
  return object({
    schemaVersion: { type: "integer", enum: [1] },
    taskIntent: { type: "string", enum: [contract.intent] },
    summary: nonempty,
    assumptions: strings,
    steps: { type: "array", items: object({ title: nonempty, rationale: text, risk: { type: "string", enum: ["low", "medium", "high"] } }) },
    proposedActions: { type: "array", items: { anyOf: actions }, ...(readOnly ? { maxItems: 0 } : {}) },
    suggestedQualityChecks: { type: "array", items: object({ command: nonempty, reason: text }),
      ...(readOnly || contract.externalSearch === "forbidden" ? { maxItems: 0 } : {}) },
    questions: { type: "array", items: text, maxItems: 0 },
  });
};

const matches = (schema: Schema, value: unknown): boolean => {
  if ("anyOf" in schema) return schema.anyOf.some(branch => matches(branch, value));
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string"
      && (!schema.enum || schema.enum.includes(value))
      && (!schema.pattern || /\S/.test(value));
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && schema.enum.includes(value);
    case "array": return Array.isArray(value)
      && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && value.every(item => matches(schema.items, item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return Object.keys(record).length === schema.required.length
        && schema.required.every(key => Object.hasOwn(record, key) && matches(schema.properties[key]!, record[key]));
    }
  }
};

/** Validate the final JSON, never a regex-selected block or repaired JSON. */
export const normalizeStructuredAgentOutput = (raw: string, contract: AgentOutputContract): string => {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw invalidOutput(); }
  if (!matches(buildAgentOutputSchema(contract), value)) throw invalidOutput();
  // The complete wire shape was checked above. Null is wire-only for optional
  // `before`; keep the existing core/domain, approval and renderer contracts.
  const wire = value as AgentPlanOutput & { proposedActions: Array<Record<string, unknown>> };
  const plan = {
    summary: wire.summary, assumptions: wire.assumptions, steps: wire.steps,
    proposedActions: wire.proposedActions.map(action => {
      if (action.type !== "file_write" || action.before !== null) return action;
      const { before: _before, ...rest } = action;
      return rest;
    }),
    suggestedQualityChecks: wire.suggestedQualityChecks, questions: wire.questions,
  };
  // Escape literal backticks so strings containing code fences cannot hijack
  // the legacy UI/parser fence. JSON decoding restores the original content.
  return "```harness_agent_plan\n" + JSON.stringify(plan).replace(/`/g, "\\u0060") + "\n```";
};

const invalidOutput = (): AgentCliError => new AgentCliError(
  AGENT_INVALID_OUTPUT, "fatal", "CLI 최종 응답이 작업별 출력 스키마 v1과 일치하지 않습니다. 실행 제안을 생성하지 않았습니다.",
);

export const structuredOutputInstructions = (contract: AgentOutputContract): string => [
  "OUTPUT CONTRACT — STRICT JSON v1",
  "Return only one JSON object conforming to the supplied output schema. No prose or markdown fences outside JSON.",
  `Set schemaVersion to 1 and taskIntent to ${JSON.stringify(contract.intent)}. Include every schema property; never add extra keys.`,
  "Put the full user-facing answer in summary. Use [] for absent lists and questions. For file_write, before must be a string or null; for shell, args must be an array.",
  "A schema-valid response is not proof of completion or approval. All proposed actions still require Harness approval and policy checks.",
  contract.authorization.mode === "read_only" ? "Read-only task: proposedActions and suggestedQualityChecks must both be []." : "",
  contract.externalSearch === "forbidden" ? "No-search task: do not propose shell actions or executable quality checks." : "",
].filter(Boolean).join("\n");
