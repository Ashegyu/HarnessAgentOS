import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { regressionCheckerId, taskContractFor, type RegisterRegressionContractInput, type RegressionContractSummary, type RegressionControlEvidence } from "@harness/core";
import { resolveValidationWorkspaceKey, type LocalStateService } from "@harness/storage";
import type { RegressionContract, RegressionSource } from "@harness/storage";
import { isRealPathWithin, isWithin } from "./runner-policy.ts";
import type { ShellRunner, ShellRunResult } from "./shell-runner.ts";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (path: string): string => process.platform === "win32" ? path.replaceAll("\\","/").toLowerCase() : path;
const summary = (c: RegressionContract): RegressionContractSummary => ({ id: c.id, taskRunId: c.taskRunId, title: c.title,
  sourcePaths: c.sourcePaths, verificationPaths: c.verificationPaths, protected: c.protectedVerification !== null, createdAt: c.createdAt });

/** Frozen inputs in SQLite; only actual positive-control success adopts a test. */
export class RegressionContractService {
  constructor(private readonly state: LocalStateService, private readonly shell: ShellRunner) {}

  async register(input: RegisterRegressionContractInput): Promise<RegressionContractSummary> {
    if (input.manualConfirmation !== true) throw new Error("Explicit confirmation of the trusted reference is required");
    const task = await this.editableTask(input.taskRunId);
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 ||
        typeof input.referenceDir !== "string" || !isAbsolute(input.referenceDir)) throw new Error("Invalid regression contract title/reference directory");
    const paths = [input.sourcePaths, input.sharedPaths, input.verificationPaths];
    if (paths.some(p => !Array.isArray(p)) || !input.sourcePaths.length || !input.verificationPaths.length) throw new Error("Source and verification paths are required");
    const all = paths.flat();
    if (all.length > 64 || all.some(p => typeof p !== "string" || !/\.cs$/i.test(p) || /[\x00-\x1f:*?"<>|]/.test(p) ||
      p.split(/[\\/]/).some(x => x === ".." || x === "." || !x || x.trim() !== x || /[.]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)) || isAbsolute(p)) ||
      new Set(all.map(key)).size !== all.length) throw new Error("Invalid or duplicate C# source paths");
    const c: RegressionContract = { id: `reg_${randomUUID()}`, taskRunId: task.id, title: input.title.trim(),
      workspaceKey: await resolveValidationWorkspaceKey(task.targetDir), createdAt: new Date().toISOString(),
      sourcePaths: input.sourcePaths, verificationPaths: input.verificationPaths, protectedVerification: null,
      referenceSources: await this.readSources(input.referenceDir,input.sourcePaths),
      sharedSources: await this.readSources(task.targetDir,input.sharedPaths) };
    await this.readSources(task.targetDir,[...input.sourcePaths,...input.verificationPaths]);
    // Shared contracts must agree with previously registered immutable inputs.
    await this.assertCompatible(task.id, c.sharedSources);
    await this.state.regressionContracts.create(c);
    return summary(c);
  }

  async list(taskRunId: string): Promise<RegressionContractSummary[]> {
    return (await this.state.regressionContracts.list(taskRunId)).map(summary);
  }

  async prepare(taskRunId: string, contractId: string) {
    const task = await this.editableTask(taskRunId);
    const c = await this.get(taskRunId,contractId);
    const inputs = await this.inputs(c,task.targetDir);
    const index = (await this.state.listStepsByTaskRun(taskRunId)).length;
    return this.state.withTransaction(state => {
      const current = state.getTaskRun(taskRunId);
      if (!current || ["done","cancelled","paused"].includes(current.status)) throw new Error("Task is no longer active");
      const step = state.createStep({ taskRunId, index, kind: "approval", title: `회귀 검사: ${c.title}`, status: "pending" });
      const cp = state.createCheckpoint({ taskRunId, stepId: step.id, reason: "before_shell", stateRef: "{}", summary: "정상 기준 구현과 현재 구현을 같은 C# 검사로 실행" });
      return state.createApproval({ taskRunId, checkpointId: cp.id, actionType: "shell",
        actionSummary: `C# 회귀 검사: ${c.title} — 정상 기준 → 현재 구현. 임시 .NET 8 프로젝트에서 컴파일·실행 (호스트 권한)`,
        proposedAction: { type: "shell", command: "dotnet", args: [], regressionCheck: { contractId, inputFingerprint: hash(inputs) } } });
    });
  }

  async assertWritable(taskRunId: string, root: string, path: string, after?: string): Promise<void> {
    if (!this.state.regressionContracts) return;
    const target = resolve(root,path);
    for (const c of await this.state.regressionContracts.list(taskRunId)) {
      for (const frozen of [...c.sharedSources,...c.protectedVerification ?? []]) {
        const protectedPath = resolve(root,frozen.path);
        let same = key(target) === key(protectedPath);
        if (!same) {
          const [a,b] = await Promise.all([realpath(target).catch(() => target),realpath(protectedPath).catch(() => protectedPath)]);
          same = key(a) === key(b);
          if (!same) {
            const [sa,sb] = await Promise.all([stat(target).catch(() => null),stat(protectedPath).catch(() => null)]);
            same = !!sa && !!sb && sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
          }
        }
        if (same && after !== frozen.content) throw new Error(`Protected regression input cannot be changed: ${frozen.path}. Add new tests separately.`);
      }
    }
  }

  async execute(taskRunId: string, root: string, check: { contractId: string; inputFingerprint: string }, signal?: AbortSignal): Promise<ShellRunResult> {
    const c = await this.get(taskRunId,check.contractId);
    const inputs = await this.inputs(c,root);
    if (hash(inputs) !== check.inputFingerprint) throw new Error("Regression inputs changed after approval; prepare a fresh approval");
    signal?.throwIfAborted();
    const started = Date.now(), temp = await mkdtemp(join(tmpdir(),"hgos-regression-"));
    let cleanup = true;
    const outputs: string[] = [];
    let regressionControl: RegressionControlEvidence | undefined;
    try {
      for (const phase of ["reference","candidate"] as const) {
        signal?.throwIfAborted();
        const dir = join(temp,phase); await mkdir(dir);
        const sources = [...(phase === "reference" ? c.referenceSources : inputs.candidate),...c.sharedSources,...inputs.verification];
        for (const [index, file] of sources.entries()) await writeFile(join(dir,`Source${index}.cs`),file.content,"utf8");
        await writeFile(join(dir,"HarnessRegression.csproj"),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation><NuGetAudit>false</NuGetAudit><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Source*.cs" /></ItemGroup></Project>`);
        await writeFile(join(dir,"NuGet.Config"),'<configuration><packageSources><clear /></packageSources></configuration>');
        const outcome = await this.shell.run({ command: "dotnet", args: ["run","--project",join(dir,"HarnessRegression.csproj"),"--configuration","Release","--no-launch-profile",
          "-p:ImportDirectoryBuildProps=false","-p:ImportDirectoryBuildTargets=false","-p:ImportDirectoryPackagesProps=false"],
          cwd: dir, timeoutMs: 120_000, idleTimeoutMs: 60_000, env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" }, signal });
        outputs.push(`${phase}: exit=${outcome.exitCode}\n${outcome.stdout}\n${outcome.stderr}`);
        regressionControl = phase==="reference"
          ? {schemaVersion:1,contractId:c.id,referenceExitCode:outcome.exitCode,
            referenceFingerprint:hash([c.referenceSources,c.sharedSources]),candidateFingerprint:hash(inputs.candidate),verificationFingerprint:hash(inputs.verification)}
          : {...regressionControl!,candidateExitCode:outcome.exitCode};
        signal?.throwIfAborted();
        if (outcome.exitCode !== 0) return { ...outcome, regressionControl, command: regressionCheckerId(c.id), cwd: root, stdout: outputs.join("\n"), durationMs: Date.now()-started };
        if (phase === "reference") {
          // Do not freeze a test that changed while its positive control was running.
          if (hash(await this.inputs(c,root)) !== check.inputFingerprint) throw new Error("Regression inputs changed during reference execution");
          await this.assertCompatible(taskRunId,inputs.verification);
          await this.state.regressionContracts.protect(c.id,inputs.verification);
        }
      }
      return { exitCode: 0, regressionControl, stdout: outputs.join("\n"), stderr: "", command: regressionCheckerId(c.id), cwd: root, durationMs: Date.now()-started };
    } catch (error) {
      cleanup = !(error && typeof error === "object" && "code" in error && error.code === "RUNNER_TERMINATION_UNCONFIRMED");
      throw error;
    } finally {
      // Preserve files if process-tree termination is unconfirmed.
      if (cleanup) await rm(temp,{ recursive: true, force: true });
    }
  }

  private async editableTask(id: string) {
    const task = await this.state.getTaskRun(id);
    if (!task || ["done","cancelled","paused"].includes(task.status) || taskContractFor(task).authorization.mode === "read_only") throw new Error("Regression registration requires an active change task");
    return task;
  }
  private async get(taskRunId: string,id: string): Promise<RegressionContract> {
    const c = (await this.state.regressionContracts.list(taskRunId)).find(c => c.id === id);
    if (!c) throw new Error("Regression contract not found for this task");
    return c;
  }
  private async assertCompatible(taskRunId: string, sources: RegressionSource[]) {
    for (const c of await this.state.regressionContracts.list(taskRunId))
      for (const existing of [...c.sharedSources,...c.protectedVerification ?? []])
        if (sources.some(s => key(s.path) === key(existing.path) && s.content !== existing.content)) throw new Error(`Protected regression conflicts: ${existing.path}`);
  }
  private async inputs(c: RegressionContract,root: string) {
    if (await resolveValidationWorkspaceKey(root) !== c.workspaceKey) throw new Error("Regression workspace changed");
    const shared = await this.readSources(root,c.sharedSources.map(s => s.path));
    const verification = await this.readSources(root,c.verificationPaths);
    if (hash(shared) !== hash(c.sharedSources) || c.protectedVerification && hash(verification) !== hash(c.protectedVerification)) throw new Error("Protected regression inputs changed or were removed");
    return { candidate: await this.readSources(root,c.sourcePaths), verification, reference: c.referenceSources, shared };
  }
  private async readSources(root: string,paths: string[]): Promise<RegressionSource[]> {
    let bytes = 0;
    const result: RegressionSource[] = [];
    for (const path of paths) {
      const target = resolve(root,path);
      if (!isWithin(root,target) || !await isRealPathWithin(root,target)) throw new Error(`Source escapes workspace: ${path}`);
      const handle = await open(target,"r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 2*1024*1024) throw new Error("Regression source budget exceeded");
        // Bound the read even if an external writer grows the file after stat.
        const buffer = Buffer.alloc(2*1024*1024+1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer,length,buffer.length-length,null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > 2*1024*1024 || (bytes += length) > 8*1024*1024) throw new Error("Regression source budget exceeded");
        result.push({ path, content: new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,length)) });
      } finally { await handle.close(); }
    }
    return result;
  }
}
