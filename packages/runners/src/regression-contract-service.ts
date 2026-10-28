import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { regressionCheckerId, taskContractFor, type RegisterRegressionContractInput, type RegressionContractSummary, type RegressionControlEvidence } from "@harness/core";
import { resolveValidationWorkspaceKey, type LocalStateService } from "@harness/storage";
import type { RegressionContract, RegressionSource } from "@harness/storage";
import { isRealPathWithin, isWithin } from "./runner-policy.ts";
import {ShellRunnerError,type ShellRunner,type ShellRunResult} from "./shell-runner.ts";
import {regressionCompilerDiagnostics} from './regression-compiler-diagnostics.ts';
import {regressionFailureFingerprint} from './regression-failure-identity.ts';

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (path: string): string => process.platform === "win32" ? path.replaceAll("\\","/").toLowerCase() : path;
const referenceSets=(c:RegressionContract):RegressionSource[][]=>[c.referenceSources,...c.additionalReferenceSources??[]];
const referenceFingerprint=(c:RegressionContract):string=>c.additionalReferenceSources?.length?hash([referenceSets(c),c.sharedSources]):hash([c.referenceSources,c.sharedSources]);
const summary = (c: RegressionContract): RegressionContractSummary => ({ id: c.id, taskRunId: c.taskRunId, title: c.title,
  sourcePaths: c.sourcePaths, verificationPaths: c.verificationPaths, protected: c.protectedVerification !== null, createdAt: c.createdAt,referenceCount:referenceSets(c).length });

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
    const extra=input.additionalReferenceDirs??[];
    if(!Array.isArray(extra)||extra.length>3||extra.some(p=>typeof p!=='string'||!isAbsolute(p)||!p.trim()))throw new Error('Additional reference limit is three absolute directories');
    const dirs=[input.referenceDir,...extra],canonical=await Promise.all(dirs.map(p=>realpath(p)));
    if(new Set(canonical.map(key)).size!==canonical.length)throw new Error('Duplicate reference directories');
    const references:RegressionSource[][]=[];let referenceBytes=0;const fingerprints=new Set<string>();
    for(const dir of dirs){
      const sources=await this.readSources(dir,input.sourcePaths),fingerprint=hash(sources);
      if(fingerprints.has(fingerprint))throw new Error('Duplicate reference implementations');fingerprints.add(fingerprint);
      referenceBytes+=sources.reduce((n,s)=>n+Buffer.byteLength(s.content,'utf8'),0);if(referenceBytes>8*1024*1024)throw new Error('Combined reference source budget exceeded');
      references.push(sources);
    }
    const c: RegressionContract = { id: `reg_${randomUUID()}`, taskRunId: task.id, title: input.title.trim(),
      workspaceKey: await resolveValidationWorkspaceKey(task.targetDir), createdAt: new Date().toISOString(),
      sourcePaths: input.sourcePaths, verificationPaths: input.verificationPaths, protectedVerification: null,
      referenceSources: references[0]!,...(references.length>1?{additionalReferenceSources:references.slice(1)}:{}),
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

  /** Current checker text for a failed positive control; never expose the reference implementation. */
  async repairVerification(taskRunId:string, evidence:RegressionControlEvidence):Promise<RegressionSource[]> {
    const task=await this.editableTask(taskRunId),c=await this.get(taskRunId,evidence.contractId);
    if(c.protectedVerification)throw new Error("Accepted verification cannot be repaired; investigate the reference/environment failure");
    const inputs=await this.inputs(c,task.targetDir);
    if(referenceFingerprint(c)!==evidence.referenceFingerprint||(evidence.references?.total??1)!==referenceSets(c).length||hash(inputs.candidate)!==evidence.candidateFingerprint||hash(inputs.verification)!==evidence.verificationFingerprint)
      throw new Error("Regression inputs changed since the failed positive control");
    return inputs.verification;
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
        actionSummary: `C# 회귀 검사: ${c.title} — 정상 기준 ${referenceSets(c).length}개 모두 → 현재 구현. 임시 .NET 8 프로젝트에서 컴파일·실행 (호스트 권한)`,
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
    const sets=referenceSets(c),exits:number[]=[];let referenceStarted:number|undefined;
    const stages=[...sets.map((sources,index)=>({phase:'reference' as const,sources,index})),{phase:'candidate' as const,sources:inputs.candidate,index:0}];
    try {
      for (const stage of stages) {
        const {phase,index}=stage;
        const phaseStarted=phase==='reference'?(referenceStarted??=Date.now()):Date.now();
        const budget=()=>{const left=120_000-(Date.now()-phaseStarted);if(left<=0)throw new ShellRunnerError('RUNNER_TIMEOUT','Regression phase exceeded its shared time budget');return left;};
        signal?.throwIfAborted();
        const dir = join(temp,phase==='reference'&&sets.length>1?`reference-${index}`:phase); await mkdir(dir);
        const sources = [...stage.sources,...c.sharedSources,...inputs.verification];
        for (const [index, file] of sources.entries()) await writeFile(join(dir,`Source${index}.cs`),file.content,"utf8");
        await writeFile(join(dir,"HarnessRegression.csproj"),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation><NuGetAudit>false</NuGetAudit><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Source*.cs" /></ItemGroup></Project>`);
        await writeFile(join(dir,"NuGet.Config"),'<configuration><packageSources><clear /></packageSources></configuration>');
        const buildBudget=budget();
        const build = await this.shell.run({ command: "dotnet", args: ["build",join(dir,"HarnessRegression.csproj"),"--configuration","Release","--nologo","--verbosity","quiet","--output",join(dir,'compiled'),
          "-p:ImportDirectoryBuildProps=false","-p:ImportDirectoryBuildTargets=false","-p:ImportDirectoryPackagesProps=false"],
          cwd: dir, timeoutMs: buildBudget, idleTimeoutMs:Math.min(60_000,buildBudget), env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" }, signal });
        signal?.throwIfAborted();
        // A successful build is distinct from running the checker. Keep their combined phase budget unchanged.
        const remaining=build.exitCode===0?budget():1;
        const outcome=build.exitCode!==0?build:await this.shell.run({command:'dotnet',args:[join(dir,'compiled','HarnessRegression.dll')],cwd:dir,timeoutMs:remaining,idleTimeoutMs:Math.min(60_000,remaining),signal});
        const label=phase==='reference'&&sets.length>1?`reference[${index+1}/${sets.length}]`:phase;
        outputs.push(`${label}: exit=${outcome.exitCode}\n${outcome.stdout}\n${outcome.stderr}`);
        if(phase==='reference')exits.push(outcome.exitCode);
        regressionControl = phase==="reference"
          ? {schemaVersion:1,contractId:c.id,referenceExitCode:outcome.exitCode,
            referenceFingerprint:referenceFingerprint(c),candidateFingerprint:hash(inputs.candidate),verificationFingerprint:hash(inputs.verification),...(sets.length>1?{references:{total:sets.length,exits:[...exits]}}:{})}
          : {...regressionControl!,candidateExitCode:outcome.exitCode};
        if(build.exitCode!==0)regressionControl.compilationFailure={phase,exitCode:build.exitCode,diagnostics:regressionCompilerDiagnostics(build.stdout+'\n'+build.stderr,sources)};
        signal?.throwIfAborted();
        if (outcome.exitCode !== 0) return { ...outcome, regressionControl,
          ...(phase==='reference'?{regressionFailureFingerprint:regressionFailureFingerprint({referenceFingerprint:referenceFingerprint(c),referenceIndex:index,stderr:outcome.stderr,compilationFailure:regressionControl.compilationFailure})}:{}),
          command: regressionCheckerId(c.id), cwd: root, stdout: outputs.join("\n"), durationMs: Date.now()-started };
        if (phase === "reference"&&index===sets.length-1) {
          // Do not freeze a test that changed while its positive control was running.
          if (hash(await this.inputs(c,root)) !== check.inputFingerprint) throw new Error("Regression inputs changed during reference execution");
          signal?.throwIfAborted();
          await this.assertCompatible(taskRunId,inputs.verification);
          signal?.throwIfAborted();
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
    return { candidate: await this.readSources(root,c.sourcePaths), verification, reference: c.referenceSources, shared,...(c.additionalReferenceSources?.length?{additionalReferences:c.additionalReferenceSources}:{}) };
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
