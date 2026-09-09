import {
  ORCHESTRATION_MODES, buildTaskContract, isTaskIntent, taskContractFor, taskRouteConflict,
  type ConversationService, type ConversationTaskDraft, type StartConversationTaskInput,
  type TaskRun,
} from "@harness/core";
import type { OrchestrationDraftInput } from "@harness/orchestration";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Whitelist IPC fields; authorization is derived by ConversationService. */
export function parseStartTaskInput(value: unknown): StartConversationTaskInput {
  if (!isObject(value) || !nonEmpty(value.userRequest)) throw new Error("작업 요청을 입력하세요.");
  const result: StartConversationTaskInput = { userRequest: value.userRequest };
  for (const key of ["threadId", "targetDir", "followUpTaskRunId", "orchInstruction", "orchPipelineId"] as const) {
    if (value[key] === undefined) continue;
    if (!nonEmpty(value[key])) throw new Error(`${key} must be a non-empty string`);
    result[key] = value[key];
  }
  if (value.intent !== undefined) {
    if (!isTaskIntent(value.intent)) throw new Error("Invalid task intent");
    result.intent = value.intent;
  }
  if (value.orchMode !== undefined) {
    if (!ORCHESTRATION_MODES.some(mode => mode === value.orchMode)) throw new Error("Invalid orchestration mode");
    result.orchMode = value.orchMode as StartConversationTaskInput["orchMode"];
  }
  if (value.orchHarness !== undefined) {
    const h = value.orchHarness;
    if (!isObject(h) || !nonEmpty(h.packageId) || !nonEmpty(h.bindingSetId) ||
        h.workflowId !== undefined && !nonEmpty(h.workflowId)) throw new Error("Invalid harness binding");
    result.orchHarness = { packageId: h.packageId, bindingSetId: h.bindingSetId,
      ...(typeof h.workflowId === "string" ? { workflowId: h.workflowId } : {}) };
  }
  if (result.orchPipelineId && result.orchHarness) throw new Error("파이프라인과 하네스 중 하나만 선택하세요.");
  return result;
}

export interface ConversationStartDeps {
  createTask: ConversationService["createTask"];
  hold: (id: string) => () => void;
  getTaskRun: (id: string) => Promise<TaskRun | null>;
  proposeCapabilities: (id: string) => Promise<unknown>;
  proposeRecommendation: (id: string) => Promise<unknown>;
  draftOrchestration: (input: OrchestrationDraftInput) => Promise<unknown>;
  markPlanningReady: (id: string) => Promise<unknown>;
  changed: (id: string) => void;
  fail: (id: string, error: unknown) => Promise<void>;
  onError: (id: string, error: unknown) => void;
}

/** New requests keep running when the renderer changes tasks or reloads. */
export class ConversationStartService {
  private readonly preparation = new Map<string, Promise<void>>();
  constructor(private readonly deps: ConversationStartDeps) {}

  async start(input: StartConversationTaskInput): Promise<ConversationTaskDraft> {
    const conflict = taskRouteConflict(buildTaskContract(input), !!(input.orchMode || input.orchPipelineId || input.orchHarness));
    if (conflict) throw new Error(conflict);
    const { orchMode, orchInstruction, orchPipelineId, orchHarness, ...taskInput } = input;
    const draft = await this.deps.createTask({ ...taskInput, mode: "agent" });
    const id = draft.taskRun.id;
    const release = this.deps.hold(id);
    this.deps.changed(id);
    const work = this.prepare(id, { ...taskInput, orchMode, orchInstruction, orchPipelineId, orchHarness })
      .catch(error => this.deps.fail(id, error))
      .catch(error => this.deps.onError(id, error))
      .finally(() => { release(); this.deps.changed(id); this.preparation.delete(id); });
    this.preparation.set(id, work);
    return draft;
  }

  waitForPreparation(id: string): Promise<void> { return this.preparation.get(id) ?? Promise.resolve(); }

  private async prepare(id: string, input: StartConversationTaskInput): Promise<void> {
    const current = await this.deps.getTaskRun(id);
    if (!current || current.status !== "drafting") return;
    const contract = taskContractFor(current);
    const readOnly = contract.authorization.mode === "read_only";
    const routeAllowed = !readOnly && contract.externalSearch !== "forbidden";
    const routed = routeAllowed && (input.orchPipelineId || input.orchHarness || input.orchMode);
    if (routed) {
      await this.deps.draftOrchestration({ taskRunId: id, mode: input.orchMode ?? "single_worker",
        ...(input.orchPipelineId ? { pipelineId: input.orchPipelineId } : {}),
        ...(input.orchHarness ? { harness: input.orchHarness } : {}),
        ...(input.orchInstruction ? { instruction: input.orchInstruction } : {}),
      });
      return;
    }
    if (!readOnly) {
      // Optional recommendations may fail independently, but neither may race
      // the first AI invocation. Persist all candidates before releasing main.
      try { await this.deps.proposeCapabilities(id); } catch { /* Advisory only. */ }
      if ((await this.deps.getTaskRun(id))?.status !== "drafting") return;
      try { await this.deps.proposeRecommendation(id); } catch { /* Advisory only. */ }
    }
    if ((await this.deps.getTaskRun(id))?.status === "drafting") await this.deps.markPlanningReady(id);
  }
}
