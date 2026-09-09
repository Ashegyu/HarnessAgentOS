import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Approval, TaskRun } from "@harness/core";
import { isRealPathWithin } from "@harness/runners";

/** Verifies delivery, not the factual correctness of the report's prose. */
export const verifyReportDelivery = async (
  task: Pick<TaskRun, "userRequest" | "targetDir" | "id">,
  approvals: readonly Approval[],
): Promise<boolean> => {
  const request = task.userRequest.replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ");
  if (!/분석|리뷰|검토|보고서|\b(?:analy[sz]e|analysis|review|report)\b/i.test(request) ||
      !/저장|생성|작성|\b(?:save|create|write)\b/i.test(request) ||
      !/\bhtml\b|마크다운|\bmarkdown\b/i.test(request) ||
      /버그|구현|수정|삭제|설치|\b(?:fix|implement|modify|update|delete|install|website|app)\b/i.test(request)) return false;
  const actions = approvals.filter(a => a.actionType !== "capability_use" && a.actionType !== "model_use" && a.actionType !== "orchestration_plan");
  if (actions.length === 0) return false;
  const extension = /\bhtml\b/i.test(request) ? ".html" : ".md";
  for (const action of actions) {
    const patch = action.proposedAction?.filePatch;
    if (action.taskRunId !== task.id || action.actionType !== "file_write" ||
        action.status !== "executed" || action.executionState !== "succeeded" ||
        action.approvedRevision !== action.actionRevision || !patch || !patch.after.trim() ||
        extname(patch.path).toLowerCase() !== extension) return false;
    const target = resolve(task.targetDir, patch.path);
    try {
      if (!(await isRealPathWithin(task.targetDir, target))) return false;
      const info = await stat(target);
      if (!info.isFile() || info.size > 4 * 1024 * 1024 ||
          info.size !== Buffer.byteLength(patch.after, "utf8")) return false;
      if (await readFile(target, "utf8") !== patch.after) return false;
    } catch { return false; }
  }
  return true;
};
