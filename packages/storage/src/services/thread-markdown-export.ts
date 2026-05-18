import type {
  Approval,
  Artifact,
  Checkpoint,
  Step,
  TaskRun,
  Thread,
} from "@harness/core";

export interface ThreadMarkdownTaskRunDetail {
  taskRun: TaskRun;
  steps: Step[];
  checkpoints: Checkpoint[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface ThreadMarkdownExportInput {
  thread: Thread;
  taskRuns: ThreadMarkdownTaskRunDetail[];
}

export const serializeThreadMarkdown = (
  input: ThreadMarkdownExportInput,
): string => {
  const lines: string[] = [];
  lines.push(`# ${input.thread.title}`);
  lines.push("");
  lines.push(`- Thread ID: \`${input.thread.id}\``);
  if (input.thread.targetDir) {
    lines.push(`- Target directory: \`${input.thread.targetDir}\``);
  }
  lines.push(`- Created: ${input.thread.createdAt}`);
  lines.push(`- Updated: ${input.thread.updatedAt}`);
  lines.push("");

  if (input.taskRuns.length === 0) {
    lines.push("## TaskRuns", "", "(none)");
    return lines.join("\n");
  }

  for (const detail of input.taskRuns) {
    appendTaskRun(lines, detail);
  }
  return `${lines.join("\n")}\n`;
};

const appendTaskRun = (
  lines: string[],
  detail: ThreadMarkdownTaskRunDetail,
): void => {
  const { taskRun } = detail;
  lines.push(`## TaskRun ${taskRun.id}`);
  lines.push("");
  lines.push(`- Status: \`${taskRun.status}\``);
  lines.push(`- Target directory: \`${taskRun.targetDir}\``);
  lines.push(`- Created: ${taskRun.createdAt}`);
  lines.push(`- Updated: ${taskRun.updatedAt}`);
  lines.push("");
  lines.push("### Request");
  lines.push("");
  lines.push(blockquote(taskRun.userRequest));
  appendSteps(lines, detail.steps);
  appendCheckpoints(lines, detail.checkpoints);
  appendApprovals(lines, detail.approvals);
  appendArtifacts(lines, detail.artifacts);
};

const appendSteps = (lines: string[], steps: Step[]): void => {
  lines.push("", "### Steps", "");
  if (steps.length === 0) {
    lines.push("(none)");
    return;
  }
  lines.push("| Index | ID | Kind | Status | Title | Output |");
  lines.push("|---:|---|---|---|---|---|");
  for (const step of steps) {
    lines.push(
      [
        step.index,
        code(step.id),
        code(step.kind),
        code(step.status),
        cell(step.title),
        cell(step.outputSummary ?? ""),
      ].join(" | "),
    );
  }
};

const appendCheckpoints = (lines: string[], checkpoints: Checkpoint[]): void => {
  lines.push("", "### Checkpoints", "");
  if (checkpoints.length === 0) {
    lines.push("(none)");
    return;
  }
  for (const checkpoint of checkpoints) {
    lines.push(
      `- ${code(checkpoint.id)} · ${code(checkpoint.reason)} · ${checkpoint.summary} · ${code(checkpoint.stateRef)}`,
    );
  }
};

const appendApprovals = (lines: string[], approvals: Approval[]): void => {
  lines.push("", "### Approvals", "");
  if (approvals.length === 0) {
    lines.push("(none)");
    return;
  }
  lines.push("| ID | Action | Status | Summary | Decision |");
  lines.push("|---|---|---|---|---|");
  for (const approval of approvals) {
    lines.push(
      [
        code(approval.id),
        code(approval.actionType),
        code(approval.status),
        cell(approval.actionSummary),
        cell(approval.decisionMessage ?? approval.autoApproveDecision?.reason ?? ""),
      ].join(" | "),
    );
  }
};

const appendArtifacts = (lines: string[], artifacts: Artifact[]): void => {
  lines.push("", "### Artifacts", "");
  if (artifacts.length === 0) {
    lines.push("(none)");
    return;
  }
  for (const artifact of artifacts) {
    const summary = artifact.summary ? ` - ${artifact.summary}` : "";
    lines.push(
      `- ${code(artifact.id)} · ${code(artifact.kind)} · ${artifact.title} · ${code(artifact.uri)}${summary}`,
    );
  }
};

const blockquote = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

const code = (value: string): string => `\`${value.replace(/`/g, "\\`")}\``;

const cell = (value: string): string =>
  value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
