import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  FilesystemArtifactStore,
  LocalStateService,
  openDb,
} from "../../../packages/storage/src/index.ts";
import { ConversationService } from "../../../packages/core/src/index.ts";
import {
  ShadowWorkspaceError,
  ShadowWorkspaceService,
} from "./shadow-workspace-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-shadow-"));
  return {
    dir,
    db: join(dir, "test.db"),
    artifacts: join(dir, "artifacts"),
    shadow: join(dir, "shadow"),
    target: join(dir, "target"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const setup = async (t) => {
  await mkdir(t.target, { recursive: true });
  const db = openDb({ filePath: t.db });
  const state = new LocalStateService(db);
  const artifactStore = new FilesystemArtifactStore({ rootDir: t.artifacts });
  const conversation = new ConversationService({
    state,
    pathExists: async () => true,
  });
  const shadow = new ShadowWorkspaceService({
    state,
    artifactStore,
    shadowRootDir: t.shadow,
  });
  return { db, state, conversation, artifactStore, shadow };
};

test("createPreview writes shadow file and artifacts without touching target", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, artifactStore, shadow } = await setup(t);
    try {
      writeFileSync(join(t.target, "hello.txt"), "old\n", "utf8");
      const draft = await conversation.createTask({
        userRequest: "change hello",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "hello.txt", after: "new\n" },
      });

      const preview = await shadow.createPreview({ approvalId: approval.id });

      assert.equal(readFileSync(join(t.target, "hello.txt"), "utf8"), "old\n");
      assert.equal(readFileSync(preview.shadowPath, "utf8"), "new\n");
      assert.equal(preview.relativePath, "hello.txt");
      assert.equal(preview.artifactIds.length, 2);
      assert.ok(preview.baselineHash);

      const artifacts = await state.listArtifactsByTaskRun(draft.taskRun.id);
      assert.ok(artifacts.some((a) => a.title === "shadow diff: hello.txt"));
      assert.ok(artifacts.some((a) => a.title === "shadow snapshot: hello.txt"));

      const snapshot = artifacts.find((a) => a.kind === "snapshot");
      const content = await artifactStore.read({
        taskRunId: snapshot.taskRunId,
        artifactId: snapshot.id,
        kind: snapshot.kind,
      });
      assert.match(content, /"relativePath": "hello.txt"/);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("createPreview supports new files inside shadow only", async () => {
  const t = tmp();
  try {
    const { db, conversation, shadow } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "create file",
        targetDir: t.target,
      });
      const approval = draft.approvals[0];
      await conversation.setProposedAction(approval.id, {
        type: "file_write",
        filePatch: { path: "src/new.txt", after: "new\n" },
      });

      const preview = await shadow.createPreview({ approvalId: approval.id });

      assert.equal(existsSync(join(t.target, "src", "new.txt")), false);
      assert.equal(readFileSync(preview.shadowPath, "utf8"), "new\n");
      assert.equal(preview.baselineHash, undefined);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("createPreview rejects non file_write approvals", async () => {
  const t = tmp();
  try {
    const { db, state, conversation, shadow } = await setup(t);
    try {
      const draft = await conversation.createTask({
        userRequest: "shell",
        targetDir: t.target,
      });
      const shellApproval = await state.createApproval({
        taskRunId: draft.taskRun.id,
        checkpointId: draft.checkpoint.id,
        actionType: "shell",
        actionSummary: "run tests",
        proposedAction: {
          type: "shell",
          command: "npm test",
        },
      });

      await assert.rejects(
        () => shadow.createPreview({ approvalId: shellApproval.id }),
        (e) =>
          e instanceof ShadowWorkspaceError &&
          e.code === "SHADOW_UNSUPPORTED_ACTION",
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});
