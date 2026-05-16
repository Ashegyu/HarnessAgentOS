import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  formatSimpleDiff,
  type ArtifactKind,
  type ArtifactStore,
  type CreateArtifactInput,
  type ShadowPreview,
} from "@harness/core";
import { newId, nowIso, type LocalStateService } from "@harness/storage";
import { isWithin } from "./runner-policy.ts";

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
    if (approval.actionType !== "file_write") {
      throw new ShadowWorkspaceError(
        "SHADOW_UNSUPPORTED_ACTION",
        `Shadow preview supports file_write only, got ${approval.actionType}`,
      );
    }

    const details = approval.proposedAction;
    const patch = details?.filePatch;
    if (!details || details.type !== "file_write" || !patch) {
      throw new ShadowWorkspaceError(
        "SHADOW_PATCH_REQUIRED",
        "file_write approval must include proposedAction.filePatch",
      );
    }

    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (!taskRun) {
      throw new ShadowWorkspaceError(
        "SHADOW_TASK_RUN_NOT_FOUND",
        `TaskRun ${approval.taskRunId} not found`,
      );
    }

    const targetPath = isAbsolute(patch.path)
      ? patch.path
      : resolve(taskRun.targetDir, patch.path);
    if (!isWithin(taskRun.targetDir, targetPath)) {
      throw new ShadowWorkspaceError(
        "SHADOW_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes targetDir: ${patch.path}`,
      );
    }

    const relativePath = relative(taskRun.targetDir, targetPath);
    const previewId = `shd_${randomUUID()}`;
    const shadowDir = join(this.deps.shadowRootDir, previewId);
    const shadowPath = resolve(shadowDir, relativePath);
    if (!isWithin(shadowDir, shadowPath)) {
      throw new ShadowWorkspaceError(
        "SHADOW_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes shadowDir: ${patch.path}`,
      );
    }

    const before = await readExistingFile(targetPath);
    const baselineHash =
      before === null ? undefined : sha256Hex(Buffer.from(before, "utf8"));
    await mkdir(dirname(shadowPath), { recursive: true });
    await writeFile(shadowPath, patch.after, "utf8");

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
      content: formatSimpleDiff({
        path: relativePath,
        before: before ?? undefined,
        after: patch.after,
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
