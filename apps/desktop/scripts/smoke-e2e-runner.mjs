// E2E smoke — UI 사용자 시나리오 전체를 코드로 재현
//
// 사용자가 Electron UI에서 하는 행동을 그대로 IPC 윗단 서비스 호출로 재현합니다.
// Computer-use가 dev-mode Electron을 인식 못하기 때문에 이 방식으로 직접 검증합니다.
//
// 시나리오:
//   1. Thread 생성 → agent 모드 TaskRun 생성
//   2. Provider 없을 때 generatePlan 거부되는지 확인
//   3. Template fallback 으로 복구 확인
//   4. approval 에 file_write proposed action 설정 + approve
//   5. RunnerService.executeApproved → 파일이 실제 디스크에 써졌는지
//   6. ArtifactStore.read 로 diff artifact 읽기 (ENOENT 없는지)
//   7. RuntimeStatusBar/RightPanel 이 보여줄 detail snapshot 확인
//
// Run:
//   npm --workspace=@harness/desktop run smoke:e2e

import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDb,
  closeDb,
  LocalStateService,
  FilesystemArtifactStore,
} from "../../../packages/storage/src/index.ts";
import { ConversationService } from "../../../packages/core/src/conversation/conversation-service.ts";
import {
  AgentInvocationQueue,
  AgentPlanningService,
  FakeModelCliAdapter,
} from "../../../packages/agent/src/index.ts";
import { RunnerService } from "../../../packages/runners/src/runner-service.ts";

const expect = (cond, label) => {
  if (cond) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}`);
  process.exitCode = 1;
  throw new Error(`assertion failed: ${label}`);
};

const header = (t) => console.log(`\n=== ${t} ===`);

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-e2e-"));
  const projectDir = join(dir, "project");
  const artifactDir = join(dir, "artifacts");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });

  const db = openDb({ filePath: join(dir, "e2e.db") });
  const state = new LocalStateService(db);
  const artifactStore = new FilesystemArtifactStore({ rootDir: artifactDir });
  const conversation = new ConversationService({
    state,
    pathExists: async (p) => existsSync(p),
  });
  const queue = new AgentInvocationQueue();
  const agent = new AgentPlanningService({
    state,
    queue,
    getProviderStatus: () => ({
      claude: { available: true, version: "fake", queueDepth: 0 },
      codex: { available: false, error: "n/a", queueDepth: 0 },
    }),
    adapter: new FakeModelCliAdapter({ scenario: "parse-error", chunkDelayMs: 0 }),
    emitStreamEvent: () => {},
    defaults: { timeoutMs: 30_000, stallTimeoutMs: 10_000 },
  });
  const runner = new RunnerService({ state, artifactStore });

  return {
    dir,
    projectDir,
    db,
    state,
    artifactStore,
    conversation,
    agent,
    runner,
    cleanup: () => {
      try { closeDb(db); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const main = async () => {
  const ctx = setup();
  try {
    // ── Step 1: Thread + agent TaskRun 생성 (UI: 새 작업 버튼 누름)
    header("1. createThread + createTask(mode=agent)");
    const thread = await ctx.state.createThread({
      title: "E2E test thread",
      targetDir: ctx.projectDir,
    });
    const draft = await ctx.conversation.createTask({
      threadId: thread.id,
      userRequest: "사용자가 입력한 요청 텍스트",
      targetDir: ctx.projectDir,
      mode: "agent",
    });
    expect(draft.taskRun.status === "drafting", `task is drafting (got ${draft.taskRun.status})`);
    expect(draft.taskRun.targetDir === ctx.projectDir, "targetDir set");

    // ── Step 2: Agent generatePlan → 실패 (parse-error 시나리오)
    header("2. agent.generatePlan() — provider fails");
    let agentErr = null;
    try {
      await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    } catch (e) {
      agentErr = e;
    }
    expect(agentErr !== null, "generatePlan rejected");
    expect(agentErr?.code === "AGENT_INVALID_OUTPUT", `error code = AGENT_INVALID_OUTPUT (got ${agentErr?.code})`);
    const blocked = await ctx.state.getTaskRun(draft.taskRun.id);
    expect(blocked.status === "blocked", `task is blocked after fail (got ${blocked.status})`);

    // ── Step 3: Template fallback (UI: "템플릿으로 진행" 버튼)
    header("3. conversation.useTemplateFallback() — recovery path");
    const fallback = await ctx.conversation.useTemplateFallback({
      taskRunId: draft.taskRun.id,
    });
    expect(fallback.planArtifact.kind === "plan", "fallback returned plan artifact");
    expect(fallback.approvals.length >= 1, `fallback created approval (got ${fallback.approvals.length})`);
    const recovered = await ctx.state.getTaskRun(draft.taskRun.id);
    expect(recovered.status === "waiting_for_approval", `task waiting_for_approval (got ${recovered.status})`);

    // ── Step 4: setProposedAction + approve (UI: 코드 변경 입력 후 승인 누름)
    header("4. setProposedAction + approve");
    const approvalId = fallback.approvals[0].id;
    await ctx.conversation.setProposedAction(approvalId, {
      type: "file_write",
      filePatch: {
        path: "result.md",
        after: "# E2E 결과\n\n사용자 요청이 성공적으로 처리되었습니다.\n",
      },
    });
    const approved = await ctx.conversation.approve({ approvalId });
    expect(approved.status === "approved", `approval status approved (got ${approved.status})`);

    // ── Step 5: Runner 실행 (UI: 자동 / 또는 명시적 실행 트리거)
    header("5. runner.executeApproved()");
    const runResult = await ctx.runner.executeApproved(approvalId);
    expect(runResult.changedFiles?.length === 1, `1 file changed (got ${runResult.changedFiles?.length})`);
    expect(runResult.artifactIds.length >= 1, `artifacts created (got ${runResult.artifactIds.length})`);

    const written = readFileSync(join(ctx.projectDir, "result.md"), "utf8");
    expect(written.includes("E2E 결과"), "file written to targetDir on disk");

    // ── Step 6: 모든 artifact 를 IPC 와 동일한 경로로 읽어 ENOENT 없는지 검증
    header("6. readArtifact (모든 종류) — UI 에서 클릭 시 동일 로직");
    const artifacts = await ctx.state.listArtifactsByTaskRun(draft.taskRun.id);

    // runner-ipc.ts 의 readArtifact handler 와 같은 분기 로직을 재현
    const simulateIpcReadArtifact = async (artifactId) => {
      const a = await ctx.state.artifacts.get(artifactId);
      if (!a) throw new Error(`ARTIFACT_NOT_FOUND ${artifactId}`);
      const onDisk = a.uri.startsWith("artifact://");
      if (!onDisk) return { artifact: a, content: a.summary ?? "" };
      const content = await ctx.artifactStore.read({
        taskRunId: a.taskRunId,
        artifactId: a.id,
        kind: a.kind,
      });
      return { artifact: a, content };
    };

    for (const a of artifacts) {
      let ok = false;
      let why = "";
      try {
        const r = await simulateIpcReadArtifact(a.id);
        ok = r.content.length > 0;
        why = `${r.content.length} bytes, uri=${a.uri.split("/")[0]}//...`;
      } catch (e) {
        why = `THREW: ${e?.code ?? ""} ${String(e).slice(0, 100)}`;
      }
      expect(ok, `read ${a.kind} (${a.title.slice(0, 30)}): ${why}`);
    }

    // URI 스킴 분포 출력 (디버깅 도움)
    const schemes = artifacts.reduce((acc, a) => {
      const s = a.uri.split("/")[0];
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  INFO  URI scheme distribution: ${JSON.stringify(schemes)}`);

    // ── Step 7: 최종 상태 (UI: RuntimeStatusBar / ConversationWorkbench)
    header("7. final TaskRun snapshot");
    const finalTask = await ctx.state.getTaskRun(draft.taskRun.id);
    expect(finalTask.status !== "blocked", `task not blocked (got ${finalTask.status})`);
    const finalArtifacts = await ctx.state.listArtifactsByTaskRun(draft.taskRun.id);
    expect(finalArtifacts.length >= 2, `multiple artifacts (plan + diff at least, got ${finalArtifacts.length})`);
    const steps = await ctx.state.listStepsByTaskRun(draft.taskRun.id);
    expect(steps.length >= 1, `steps created (got ${steps.length})`);

    console.log("\n=== TaskRun summary ===");
    console.log(`  status      : ${finalTask.status}`);
    console.log(`  steps       : ${steps.length}`);
    console.log(`  artifacts   : ${finalArtifacts.map((a) => a.kind).join(", ")}`);
    console.log(`  changedFile : ${runResult.changedFiles?.[0]}`);

    if ((process.exitCode ?? 0) === 0) {
      console.log("\nE2E SMOKE OK — 전체 UI 시나리오 통과");
    } else {
      console.error("\nE2E SMOKE FAILED");
    }
  } finally {
    ctx.cleanup();
  }
};

main().catch((e) => {
  console.error("smoke-e2e crashed:", e);
  process.exit(1);
});
