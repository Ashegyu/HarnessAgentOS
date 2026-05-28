import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  formatSimpleDiff,
  type ArtifactKind,
  type ArtifactStore,
  type CreateArtifactInput,
  type ProposedActionDetails,
  type ShadowPreview,
} from "@harness/core";
import { newId, nowIso, type LocalStateService } from "@harness/storage";
import { isWithin } from "./runner-policy.ts";
import {
  applySingleFileUnifiedPatch,
  UnifiedPatchError,
} from "./unified-patch.ts";

export class ShadowWorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShadowWorkspaceError";
    this.code = code;
  }
}

export interface ShadowWorkspaceServiceDeps {
  state: LocalStateService;
  artifactStore: ArtifactStore;
  shadowRootDir: string;
}

export class ShadowWorkspaceService {
  private readonly deps: ShadowWorkspaceServiceDeps;

  constructor(deps: ShadowWorkspaceServiceDeps) {
    this.deps = deps;
  }

  async createPreview(input: { approvalId: string }): Promise<ShadowPreview> {
    const approval = await this.deps.state.getApproval(input.approvalId);
    if (!approval) {
      throw new ShadowWorkspaceError(
        "SHADOW_APPROVAL_NOT_FOUND",
        `Approval ${input.approvalId} not found`,
      );
    }
    if (approval.status === "executed" || approval.status === "rejected") {
      throw new ShadowWorkspaceError(
        "SHADOW_APPROVAL_NOT_PREVIEWABLE",
        `Approval ${approval.id} is ${approval.status}`,
      );
    }
    if (
      approval.actionType !== "file_write" &&
      approval.actionType !== "file_patch"
    ) {
      throw new ShadowWorkspaceError(
        "SHADOW_UNSUPPORTED_ACTION",
        `Shadow preview supports file_write/file_patch only, got ${approval.actionType}`,
      );
    }

    const details = approval.proposedAction;
    const fileWritePatch = details?.filePatch;
    const unifiedPatch = details?.unifiedPatch;
    if (
      !details ||
      details.type !== approval.actionType ||
      (details.type !== "file_write" && details.type !== "file_patch") ||
      (details.type === "file_write" && !fileWritePatch) ||
      (details.type === "file_patch" && !unifiedPatch)
    ) {
      throw new ShadowWorkspaceError(
        "SHADOW_PATCH_REQUIRED",
        "file_write approval must include proposedAction.filePatch and file_patch approval must include proposedAction.unifiedPatch",
      );
    }

    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (!taskRun) {
      throw new ShadowWorkspaceError(
        "SHADOW_TASK_RUN_NOT_FOUND",
        `TaskRun ${approval.taskRunId} not found`,
      );
    }

    const proposedPath =
      details.type === "file_write" ? fileWritePatch!.path : unifiedPatch!.path;
    const targetPath = isAbsolute(proposedPath)
      ? proposedPath
      : resolve(taskRun.targetDir, proposedPath);
    if (!isWithin(taskRun.targetDir, targetPath)) {
      throw new ShadowWorkspaceError(
        "SHADOW_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes targetDir: ${proposedPath}`,
      );
    }

    const relativePath = relative(taskRun.targetDir, targetPath);
    const previewId = `shd_${randomUUID()}`;
    const shadowDir = join(this.deps.shadowRootDir, previewId);
    const shadowPath = resolve(shadowDir, relativePath);
    if (!isWithin(shadowDir, shadowPath)) {
      throw new ShadowWorkspaceError(
        "SHADOW_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes shadowDir: ${proposedPath}`,
      );
    }

    const before = await readExistingFile(targetPath);
    const after = applyPreviewPatch({
      relativePath,
      before,
      details,
    });
    const baselineHash =
      before === null ? undefined : sha256Hex(Buffer.from(before, "utf8"));
    await mkdir(dirname(shadowPath), { recursive: true });
    await writeFile(shadowPath, after, "utf8");

    const stepIndex = (await this.deps.state.listStepsByTaskRun(taskRun.id)).length;
    const step = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "edit",
      title: `shadow preview: ${relativePath}`,
      status: "running",
      inputSummary: `preview ${approval.id}`,
    });

    const diffArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "diff",
      title: `shadow diff: ${relativePath}`,
      content:
        details.type === "file_patch"
          ? details.unifiedPatch!.patch
          : formatSimpleDiff({
              path: relativePath,
              before: before ?? undefined,
              after,
            }),
      summary: `shadow preview for ${relativePath}`,
    });
    const snapshotArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "snapshot",
      title: `shadow snapshot: ${relativePath}`,
      content: JSON.stringify(
        {
          id: previewId,
          taskRunId: taskRun.id,
          approvalId: approval.id,
          targetDir: taskRun.targetDir,
          relativePath,
          targetPath,
          shadowPath,
          baselineHash: baselineHash ?? null,
          createdAt: nowIso(),
        },
        null,
        2,
      ),
      summary: `shadow file ${shadowPath}`,
    });
    await this.deps.state.setStepStatus(step.id, "succeeded", {
      outputSummary: `shadow ${previewId}; artifacts=2`,
    });

    return {
      id: previewId,
      taskRunId: taskRun.id,
      approvalId: approval.id,
      targetDir: taskRun.targetDir,
      relativePath,
      shadowPath,
      ...(baselineHash !== undefined ? { baselineHash } : {}),
      artifactIds: [diffArtifact.id, snapshotArtifact.id],
      createdAt: nowIso(),
    };
  }

  private async persistArtifact(input: {
    taskRunId: string;
    stepId: string;
    kind: ArtifactKind;
    title: string;
    content: string;
    summary?: string;
  }): Promise<{ id: string; uri: string }> {
    const artifactId = newId("artifact");
    const written = await this.deps.artifactStore.write({
      taskRunId: input.taskRunId,
      artifactId,
      kind: input.kind,
      content: input.content,
    });
    const dbInput: CreateArtifactInput = {
      id: artifactId,
      taskRunId: input.taskRunId,
      stepId: input.stepId,
      kind: input.kind,
      title: input.title,
      uri: written.uri,
    };
    if (input.summary !== undefined) dbInput.summary = input.summary;
    const stored = await this.deps.state.createArtifact(dbInput);
    return { id: stored.id, uri: stored.uri };
  }
}

const applyPreviewPatch = (input: {
  relativePath: string;
  before: string | null;
  details: ProposedActionDetails;
}): string => {
  if (input.details.type === "file_write") {
    const patch = input.details.filePatch;
    if (!patch) {
      throw new ShadowWorkspaceError(
        "SHADOW_PATCH_REQUIRED",
        "file_write approval must include proposedAction.filePatch",
      );
    }
    return patch.after;
  }

  const patch = input.details.unifiedPatch;
  if (!patch) {
    throw new ShadowWorkspaceError(
      "SHADOW_PATCH_REQUIRED",
      "file_patch approval must include proposedAction.unifiedPatch",
    );
  }
  if (input.before === null) {
    throw new ShadowWorkspaceError(
      "SHADOW_PATCH_CONTEXT_MISMATCH",
      `Patch target does not exist: ${input.relativePath}`,
    );
  }
  try {
    return applySingleFileUnifiedPatch({
      currentContent: input.before,
      patch: patch.patch,
      path: input.relativePath,
    }).afterContent;
  } catch (e) {
    if (e instanceof UnifiedPatchError) {
      throw new ShadowWorkspaceError(e.code, e.message);
    }
    throw e;
  }
};

const readExistingFile = async (path: string): Promise<string | null> => {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      throw new ShadowWorkspaceError(
        "SHADOW_TARGET_NOT_FILE",
        `Shadow preview target is not a file: ${path}`,
      );
    }
    return await readFile(path, "utf8");
  } catch (e) {
    if (
      e instanceof ShadowWorkspaceError ||
      (typeof e === "object" &&
        e !== null &&
        (e as { code?: unknown }).code !== "ENOENT")
    ) {
      throw e;
    }
    return null;
  }
};

const sha256Hex = (input: Buffer): string =>
  createHash("sha256").update(input).digest("hex");
