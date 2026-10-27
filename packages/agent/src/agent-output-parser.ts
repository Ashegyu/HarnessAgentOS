import type {
  AgentPlanOutput,
  AgentProposedAction,
} from "@harness/core";
import { extractAgentPlanEnvelope, parseJsonAllowingMultilineStrings } from "@harness/core";

export interface ParsedAgentPlan {
  ok: true;
  plan: AgentPlanOutput;
}

export interface ParseAgentPlanFailure {
  ok: false;
  reason: string;
}

export type ParseAgentPlanResult = ParsedAgentPlan | ParseAgentPlanFailure;

/**
 * Extract the `harness_agent_plan` fenced JSON block from raw agent
 * output, parse it, and validate that it conforms to AgentPlanOutput.
 *
 * Phase 8 §11 (prompt injection defense) — this parser MUST NOT trust
 * any field beyond what the schema explicitly enumerates. Anything
 * extra is dropped silently. Action policy (path traversal, dangerous
 * shell) is enforced separately by AgentPlanningService before any
 * approval row is written.
 */
export const parseAgentPlan = (rawOutput: string, redactText?: (text: string) => string): ParseAgentPlanResult => {
  const json = extractAgentPlanEnvelope(rawOutput)?.json;
  if (!json) {
    return {
      ok: false,
      reason:
        "No fenced JSON block tagged `harness_agent_plan` found in agent output.",
    };
  }
  let parsed: unknown;
  const parseResult = parseJsonAllowingMultilineStrings(json);
  if (!parseResult.ok) {
    return {
      ok: false,
      reason: `Agent JSON parse error: ${parseResult.reason}`,
    };
  }
  parsed = parseResult.value;
  const validated = validateAgentPlan(parsed);
  if (!validated.ok) return validated;
  // Redact display metadata only. Executable preimages, generated contents,
  // paths, patches and commands must remain byte-for-byte approval candidates.
  // Audit artifacts are separately redacted by the caller.
  const plan: AgentPlanOutput = redactText
    ? {
        ...validated.plan,
        summary: redactText(validated.plan.summary),
        assumptions: validated.plan.assumptions.map(redactText),
        steps: validated.plan.steps.map(step => ({ ...step, title: redactText(step.title), rationale: redactText(step.rationale) })),
        proposedActions: validated.plan.proposedActions.map(action => ({ ...action, rationale: redactText(action.rationale) })),
        suggestedQualityChecks: validated.plan.suggestedQualityChecks.map(check => ({ ...check, reason: redactText(check.reason) })),
      }
    : validated.plan;
  return { ok: true, plan };
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const validateAgentPlan = (value: unknown): ParseAgentPlanResult => {
  if (!isObject(value)) {
    return { ok: false, reason: "Agent plan must be a JSON object." };
  }
  const summary = value.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, reason: "summary must be a non-empty string." };
  }
  const assumptions = value.assumptions ?? [];
  if (!isStringArray(assumptions)) {
    return { ok: false, reason: "assumptions must be string[]." };
  }
  const steps = value.steps ?? [];
  if (!Array.isArray(steps)) {
    return { ok: false, reason: "steps must be an array." };
  }
  const stepsOut: AgentPlanOutput["steps"] = [];
  for (const [i, s] of steps.entries()) {
    if (!isObject(s)) {
      return { ok: false, reason: `steps[${i}] must be an object.` };
    }
    if (typeof s.title !== "string" || s.title.length === 0) {
      return { ok: false, reason: `steps[${i}].title must be a non-empty string.` };
    }
    if (typeof s.rationale !== "string") {
      return { ok: false, reason: `steps[${i}].rationale must be a string.` };
    }
    if (s.risk !== "low" && s.risk !== "medium" && s.risk !== "high") {
      return {
        ok: false,
        reason: `steps[${i}].risk must be one of low | medium | high.`,
      };
    }
    stepsOut.push({ title: s.title, rationale: s.rationale, risk: s.risk });
  }
  const proposedRaw = value.proposedActions ?? [];
  if (!Array.isArray(proposedRaw)) {
    return { ok: false, reason: "proposedActions must be an array." };
  }
  const proposedOut: AgentProposedAction[] = [];
  for (const [i, a] of proposedRaw.entries()) {
    const parsed = validateProposedAction(a, i);
    if (!parsed.ok) return parsed;
    proposedOut.push(parsed.action);
  }
  const checksRaw = value.suggestedQualityChecks ?? [];
  if (!Array.isArray(checksRaw)) {
    return { ok: false, reason: "suggestedQualityChecks must be an array." };
  }
  const checksOut: AgentPlanOutput["suggestedQualityChecks"] = [];
  for (const [i, c] of checksRaw.entries()) {
    if (!isObject(c)) {
      return { ok: false, reason: `suggestedQualityChecks[${i}] must be an object.` };
    }
    if (typeof c.command !== "string" || c.command.trim().length === 0) {
      return {
        ok: false,
        reason: `suggestedQualityChecks[${i}].command must be a non-empty string.`,
      };
    }
    if (typeof c.reason !== "string") {
      return {
        ok: false,
        reason: `suggestedQualityChecks[${i}].reason must be a string.`,
      };
    }
    checksOut.push({ command: c.command, reason: c.reason });
  }
  const questions = value.questions ?? [];
  if (!isStringArray(questions)) {
    return { ok: false, reason: "questions must be string[]." };
  }
  // Agent runs are not interactive. Preserve schema compatibility, but drop
  // user-blocking questions so downstream UI and artifacts keep moving.
  const plan: AgentPlanOutput = {
    summary,
    assumptions,
    steps: stepsOut,
    proposedActions: proposedOut,
    suggestedQualityChecks: checksOut,
    questions: [],
  };
  return { ok: true, plan };
};

interface ProposedActionOk {
  ok: true;
  action: AgentProposedAction;
}

const validateProposedAction = (
  value: unknown,
  index: number,
): ProposedActionOk | ParseAgentPlanFailure => {
  if (!isObject(value)) {
    return { ok: false, reason: `proposedActions[${index}] must be an object.` };
  }
  if (value.type === "file_delete") {
    if (typeof value.path !== "string" || !value.path.trim() || typeof value.rationale !== "string") {
      return { ok: false, reason: `proposedActions[${index}] requires path and rationale` };
    }
    return { ok: true, action: { type: "file_delete", path: value.path, rationale: value.rationale } };
  }
  if (value.type === "file_patch") {
    if (typeof value.path !== "string" || value.path.length === 0) {
      return {
        ok: false,
        reason: `proposedActions[${index}].path must be a non-empty string.`,
      };
    }
    if (typeof value.patch !== "string" || value.patch.trim().length === 0) {
      return {
        ok: false,
        reason: `proposedActions[${index}].patch must be a non-empty string.`,
      };
    }
    if (typeof value.rationale !== "string") {
      return {
        ok: false,
        reason: `proposedActions[${index}].rationale must be a string.`,
      };
    }
    return {
      ok: true,
      action: {
        type: "file_patch",
        path: value.path,
        patch: value.patch,
        rationale: value.rationale,
      },
    };
  }
  if (value.type === "file_write") {
    if (typeof value.path !== "string" || value.path.length === 0) {
      return {
        ok: false,
        reason: `proposedActions[${index}].path must be a non-empty string.`,
      };
    }
    if (typeof value.after !== "string") {
      return {
        ok: false,
        reason: `proposedActions[${index}].after must be a string.`,
      };
    }
    if (typeof value.rationale !== "string") {
      return {
        ok: false,
        reason: `proposedActions[${index}].rationale must be a string.`,
      };
    }
    const action: AgentProposedAction = {
      type: "file_write",
      path: value.path,
      after: value.after,
      rationale: value.rationale,
    };
    if (typeof value.before === "string") action.before = value.before;
    return { ok: true, action };
  }
  if (value.type === "shell") {
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      return {
        ok: false,
        reason: `proposedActions[${index}].command must be a non-empty string.`,
      };
    }
    if (typeof value.rationale !== "string") {
      return {
        ok: false,
        reason: `proposedActions[${index}].rationale must be a string.`,
      };
    }
    if (value.args !== undefined && !isStringArray(value.args)) {
      return {
        ok: false,
        reason: `proposedActions[${index}].args must be string[] when provided.`,
      };
    }
    const action: AgentProposedAction = {
      type: "shell",
      command: value.command,
      rationale: value.rationale,
    };
    if (Array.isArray(value.args)) action.args = value.args.slice();
    return { ok: true, action };
  }
  return {
    ok: false,
    reason: `proposedActions[${index}].type must be 'file_patch', 'file_write', 'file_delete', or 'shell'.`,
  };
};
