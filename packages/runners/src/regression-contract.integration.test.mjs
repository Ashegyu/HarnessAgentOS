import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, LocalStateService, FilesystemArtifactStore } from "@harness/storage";
import { ConversationService, validateProposedActionDetails } from "@harness/core";
import { QualityEvaluator } from "@harness/quality";
import { RunnerService } from "./runner-service.ts";
import { ShellRunner } from "./shell-runner.ts";
import { inspectDeleteFile } from "./file-delete-runner.ts";
import { FailureLearningService, InstinctService, ObservationRecallService } from "@harness/learner";

const source = `using System.Text.Json;
public static class Api {
 public static int Value()=>7;
 public static async Task<string> GetAsync(string key){ArgumentNullException.ThrowIfNull(key);await Task.Yield();return key;}
 public static string Read(string text){using var d=JsonDocument.Parse(text);if(d.RootElement.ValueKind!=JsonValueKind.Object)throw new InvalidDataException();return text;}
 public sealed record Snapshot(long Revision,IReadOnlyDictionary<string,int> Values);
 public static Snapshot Capture()=>new(0,new System.Collections.ObjectModel.ReadOnlyDictionary<string,int>(new Dictionary<string,int>()));
}`;
const validTest = `internal static class Program{static void Main(){if(Api.Value()!=7)throw new Exception("original regression");}}`;
const fakeSuccess = { run: async input => ({exitCode:0,stdout:"unit fixture",stderr:"",durationMs:1,command:input.command,cwd:input.cwd}) };

async function fixture(candidate = source, verification = validTest, shellRunner) {
  const root = await mkdtemp(join(tmpdir(), "hgos-regression-contract-"));
  const project = join(root, "project"), reference = join(root, "reference");
  await mkdir(project); await mkdir(reference);
  await writeFile(join(project, "Api.cs"), candidate); await writeFile(join(project, "Verification.cs"), verification);
  await writeFile(join(reference, "Api.cs"), source);
  const db = openDb({ filePath: join(root, "state.sqlite") }), state = new LocalStateService(db);
  const thread = await state.createThread({ title: "regression", targetDir: project });
  const task = await state.createTaskRun({ threadId: thread.id, targetDir: project, userRequest: "C# 코드를 수정하고 검사해줘", intent: "change" });
  const realShell = new ShellRunner();
  const artifactStore = new FilesystemArtifactStore({ rootDir: join(root,"artifacts") });
  const runner = new RunnerService({ state, artifactStore,
    shellRunner: shellRunner ?? { run: async input => {
      const result = await realShell.run(input);
      if (process.env.HARNESS_REGRESSION_DIAGNOSTICS === "1" && result.exitCode !== 0) console.error(result.stdout,result.stderr);
      return result;
    } } });
  const conversation = new ConversationService({ state, pathExists: () => true, inspectDeleteFile });
  const register = () => runner.registerRegressionContract({ taskRunId: task.id, title: "API regressions", referenceDir: reference,
    sourcePaths: ["Api.cs"], sharedPaths: [], verificationPaths: ["Verification.cs"], manualConfirmation: true });
  const approve = a => conversation.approve({ approvalId: a.id, expectedRevision: a.actionRevision, manualConfirmation: true });
  const check = async contract => { const approval = await runner.prepareRegressionCheck({ taskRunId: task.id, contractId: contract.id }); await approve(approval); return runner.executeApproved(approval.id); };
  const edit = async (path, after) => {
    const step = await state.createStep({ taskRunId: task.id, index: (await state.listStepsByTaskRun(task.id)).length, kind: "approval", title: "edit", status: "pending" });
    const cp = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "repair" });
    const a = await state.createApproval({ taskRunId: task.id, checkpointId: cp.id, actionType: "file_write", actionSummary: "repair file",
      proposedAction: { type: "file_write", filePatch: { path, after } } });
    await approve(a); return runner.executeApproved(a.id);
  };
  return { root, project, reference, db, state, task, runner, artifactStore, register, approve, check, edit,
    cleanup: async () => { await runner.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("host regression check metadata survives validation and cannot accompany arbitrary commands", () => {
  const details = { type: "shell", command: "dotnet", args: [], regressionCheck: { contractId: "reg_fixture", inputFingerprint: "a".repeat(64) } };
  assert.deepEqual(validateProposedActionDetails(details, "shell").details?.regressionCheck, details.regressionCheck);
  assert.equal(validateProposedActionDetails({ ...details, command: "node" }, "shell").ok, false);
});

test("registration invalidates old quality, requires explicit trust, and never starts a process", async () => {
  let calls = 0; const f = await fixture(source, validTest, { run: async () => { calls++; throw new Error("must not execute"); } });
  try {
    await assert.rejects(f.runner.registerRegressionContract({ taskRunId: f.task.id, title: "no trust", referenceDir: f.reference,
      sourcePaths: ["Api.cs"], sharedPaths: [], verificationPaths: ["Verification.cs"], manualConfirmation: false }), /confirm|trust|확인/i);
    const contract = await f.register();
    assert.equal(contract.protected, false);
    assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id })).length, 1);
    const gate = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(gate.status, "not_run");
    assert.ok(gate.knownRisks.some(x => /regression|회귀/i.test(x)));
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("a regression approval refuses changed inputs before spawning and remains manual", async () => {
  let calls = 0; const f = await fixture(source, validTest, { run: async () => { calls++; throw new Error("must not execute"); } });
  try {
    const contract = await f.register();
    const approval = await f.runner.prepareRegressionCheck({ taskRunId: f.task.id, contractId: contract.id });
    await assert.rejects(f.runner.executeApproved(approval.id), /approv/i);
    await f.approve(approval);
    await writeFile(join(f.project, "Api.cs"), source + "\n// changed after approval");
    await assert.rejects(f.runner.executeApproved(approval.id), /changed|stale|변경/i);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("registration bounds paths, files, trust and task scope without executing anything", async () => {
  const f = await fixture(source,validTest,fakeSuccess);
  const input = {taskRunId:f.task.id,title:"inputs",referenceDir:f.reference,sourcePaths:["Api.cs"],sharedPaths:[],verificationPaths:["Verification.cs"],manualConfirmation:true};
  try {
    for (const sourcePaths of [["../Api.cs"],["Api.cs","API.cs"],["nul.cs"],[],["bad*.cs"],["Api.cs",17]])
      await assert.rejects(f.runner.registerRegressionContract({...input,sourcePaths}));
    await assert.rejects(f.runner.registerRegressionContract({...input,referenceDir:"relative"}));
    await writeFile(join(f.reference,"Large.cs"),"x".repeat(2*1024*1024+1));
    await assert.rejects(f.runner.registerRegressionContract({...input,sourcePaths:["Large.cs"]}),/budget/i);
    await writeFile(join(f.project,"Verification.cs"),Buffer.from([0xff]));
    await assert.rejects(f.register(),/encoded|encoding|valid/i);
    await writeFile(join(f.project,"Verification.cs"),validTest);
    const other = await f.state.createTaskRun({threadId:f.task.threadId,targetDir:f.project,userRequest:"설명만 해줘",intent:"answer"});
    await assert.rejects(f.runner.registerRegressionContract({...input,taskRunId:other.id}),/change task/i);
    await assert.rejects(f.runner.prepareRegressionCheck({taskRunId:f.task.id,contractId:"missing"}),/not found/i);
    assert.deepEqual(await f.runner.listRegressionContracts({taskRunId:f.task.id}),[]);
  } finally { await f.cleanup(); }
});

test("frozen references survive live reference edits and SQLite reopen; every registered checker is mandatory", async () => {
  const f = await fixture(source,validTest,fakeSuccess);
  try {
    const contract = await f.register();
    const before = await f.state.regressionContracts.list(f.task.id);
    const epoch = await f.state.workspaceMutations.get(before[0].workspaceKey);
    assert.equal(epoch.generation,1);
    await writeFile(join(f.reference,"Api.cs"),"invalid live reference");
    await f.check(contract);
    assert.equal((await f.state.regressionContracts.list(f.task.id))[0].referenceSources[0].content,source);
    const reopened = openDb({filePath:join(f.root,"state.sqlite")});
    try {
      const persisted = await new LocalStateService(reopened).regressionContracts.list(f.task.id);
      assert.equal(persisted[0].protectedVerification[0].content,validTest);
      await assert.rejects(f.state.regressionContracts.protect(contract.id,[{path:"Verification.cs",content:"weakened"}]),/protected/i);
      await assert.rejects(f.state.regressionContracts.protect("missing",[]),/not found/i);
    } finally { reopened.close(); }
    await writeFile(join(f.reference,"Api.cs"),source);
    const previousGate = await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true});
    await f.state.assertQualityGateCurrent(previousGate);
    const second = await f.register();
    assert.notEqual(second.id,contract.id);
    await assert.rejects(f.state.assertQualityGateCurrent(previousGate),/changed/i);
    await f.check(contract); // Another current test pass cannot stand in for the second contract.
    const gate = await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true});
    assert.equal(gate.status,"not_run");
    assert.ok(gate.knownRisks.some(x=>x.includes("회귀")));
  } finally { await f.cleanup(); }
});

test("reference cancellation/infrastructure failure never freezes tests and cleans owned temporary projects", async () => {
  for (const code of ["RUNNER_CANCELLED","RUNNER_TIMEOUT"]) {
    let cwd;
    const f = await fixture(source,validTest,{run:async input=>{cwd=input.cwd;throw Object.assign(new Error(code),{code});}});
    try {
      const c = await f.register();
      await assert.rejects(f.check(c),new RegExp(code));
      assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,false);
      await assert.rejects(readFile(join(cwd,"HarnessRegression.csproj")),/ENOENT/);
      const gate = await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true});
      assert.equal(gate.status,"not_run");
    } finally { await f.cleanup(); }
  }
});

test("explicit regression inputs remain current even in normally excluded directories", async () => {
  const f = await fixture(source,validTest,fakeSuccess);
  try {
    await mkdir(join(f.project,"bin"));
    await writeFile(join(f.project,"bin","Verification.cs"),validTest);
    const c = await f.runner.registerRegressionContract({taskRunId:f.task.id,title:"excluded test",referenceDir:f.reference,
      sourcePaths:["Api.cs"],sharedPaths:[],verificationPaths:["bin/Verification.cs"],manualConfirmation:true});
    await f.check(c);
    const previous = await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true});
    assert.notEqual(previous.status,"not_run");
    await writeFile(join(f.project,"bin","Verification.cs"),"internal static class Program{static void Main(){}}");
    await assert.rejects(f.state.assertQualityGateCurrent(previous),/changed/i);
    const gate = await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true});
    assert.equal(gate.status,"not_run");
  } finally { await f.cleanup(); }
});

test("shared contracts and accepted tests reject patches, exports and aliases while exact restoration stays possible", async () => {
  const f = await fixture(source,validTest,fakeSuccess);
  try {
    await writeFile(join(f.project,"Contracts.cs"),"// fixed public contract");
    const c = await f.runner.registerRegressionContract({taskRunId:f.task.id,title:"shared",referenceDir:f.reference,
      sourcePaths:["Api.cs"],sharedPaths:["Contracts.cs"],verificationPaths:["Verification.cs"],manualConfirmation:true});
    await assert.rejects(f.edit("Contracts.cs","// changed contract"),/protected/i);
    await f.check(c);
    // Guard uses canonical identity, including links inside the workspace.
    await link(join(f.project,"Verification.cs"),join(f.project,"Alias.cs"));
    const {RegressionContractService} = await import("./regression-contract-service.ts");
    const service = new RegressionContractService(f.state,fakeSuccess);
    await assert.rejects(service.assertWritable(f.task.id,f.project,"Alias.cs","weaker"),/protected|ENOENT/i);
    await assert.rejects(service.assertWritable(f.task.id,f.project,"Verification.cs"),/protected/i);
    await service.assertWritable(f.task.id,f.project,"Verification.cs",validTest);
    await service.assertWritable(f.task.id,f.project,"Api.cs","repaired implementation");
  } finally { await f.cleanup(); }
});

const real = { skip: process.env.HARNESS_DOTNET_INTEGRATION !== "1", timeout: 120_000 };

test("positive-control verifier repairs are learned and recalled for new test-writing domains",async()=>{
  const outcomes=[1,0,0];
  const f=await fixture(source,"// wrong verification",{run:async input=>({exitCode:input.args?.[0]==='build'?0:outcomes.shift(),stdout:"invalid assertion on a valid implementation",stderr:"",command:input.command,cwd:input.cwd,durationMs:1})});
  try{
    const c=await f.register();await assert.rejects(f.check(c));await f.edit("Verification.cs",validTest);await f.check(c);
    await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true,requireBuild:false,requireSmoke:false});
    const [observation]=await new FailureLearningService({state:f.state,artifactStore:f.artifactStore}).recordRecovery({taskRunId:f.task.id});
    assert.equal(observation.payload.failureLesson.control?.kind,"verification_repair");
    const service=new InstinctService({state:f.state});await service.refreshCandidates({projectKey:observation.projectKey});
    const candidate=(await service.listCandidates({projectKey:observation.projectKey})).find(x=>x.observationIds.includes(observation.id));
    const query={...f.task,id:"new-domain",userRequest:"Provide deterministic regression tests for an asynchronous resource manager"};
    assert.deepEqual(await service.forTask({taskRun:query}),[]);
    await service.approveCandidate({candidateId:candidate.id});
    const selected=await service.forTask({taskRun:query});assert.equal(selected.length,1);
    assert.equal(selected[0].failureLesson.control.kind,"verification_repair");
    assert.deepEqual(await service.forTask({taskRun:{...query,userRequest:"Render a dark button"}}),[]);
    assert.deepEqual(await service.forTask({taskRun:{...query,userRequest:"Do not write tests; explain the resource manager"}}),[]);
    const recall=await new ObservationRecallService({state:f.state}).recall({projectKey:observation.projectKey,query:"write tests for an async adapter",excludeTaskRunId:query.id});
    assert.ok(recall.some(r=>r.failureLesson?.control?.kind==="verification_repair"));
  }finally{await f.cleanup();}
});

test("a no-op checker write followed by a lucky pass is not learned as a verifier repair",async()=>{
  const outcomes=[1,0,0],unchanged="// identical checker";
  const f=await fixture(source,unchanged,{run:async input=>({exitCode:input.args?.[0]==='build'?0:outcomes.shift(),stdout:"intermittent outcome",stderr:"",command:input.command,cwd:input.cwd,durationMs:1})});
  try{
    const c=await f.register();await assert.rejects(f.check(c));await f.edit("Verification.cs",unchanged);await f.check(c);
    await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true,requireBuild:false,requireSmoke:false});
    assert.deepEqual(await new FailureLearningService({state:f.state,artifactStore:f.artifactStore}).recordRecovery({taskRunId:f.task.id}),[]);
  }finally{await f.cleanup();}
});

test("deferred cleanup is a valid positive control; learn the checker repair without assuming immediate effects",real,async()=>{
  const implementation=`public sealed class CloseSession {
    readonly CancellationTokenSource lifetime=new();
    readonly TaskCompletionSource cleanup=new(TaskCreationOptions.RunContinuationsAsynchronously), work=new(TaskCreationOptions.RunContinuationsAsynchronously);
    Task? stop; public bool IsClosed{get;private set;} public CancellationToken Token=>lifetime.Token;
    public Task StopAsync(){IsClosed=true;return stop??=Drain();}
    async Task Drain(){await cleanup.Task;lifetime.Cancel();await work.Task;}
    public void AllowCleanup()=>cleanup.TrySetResult();public void CompleteWork()=>work.TrySetResult();
  }`;
  const bad=`internal static class Program{static async Task Main(){var s=new CloseSession();var stop=s.StopAsync();try{if(!s.IsClosed)throw new Exception("admission must close immediately");if(!s.Token.IsCancellationRequested)throw new Exception("unsupported immediate effect assumption");}finally{s.AllowCleanup();s.CompleteWork();await stop.WaitAsync(TimeSpan.FromSeconds(3));}}}`;
  const good=`internal static class Program{static async Task Main(){var s=new CloseSession();var signal=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);using var registration=s.Token.Register(()=>signal.TrySetResult());var stop=s.StopAsync();try{if(!s.IsClosed)throw new Exception("admission must close immediately");s.AllowCleanup();await signal.Task.WaitAsync(TimeSpan.FromSeconds(3));if(stop.IsCompleted)throw new Exception("must drain work");}finally{s.AllowCleanup();s.CompleteWork();await stop.WaitAsync(TimeSpan.FromSeconds(3));}}}`;
  const f=await fixture(implementation,bad);
  try{
    await writeFile(join(f.reference,"Api.cs"),implementation);
    const c=await f.register();await assert.rejects(f.check(c));
    assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,false);
    await f.edit("Verification.cs",good);await f.check(c);
    await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true,requireBuild:false,requireSmoke:false});
    const [o]=await new FailureLearningService({state:f.state,artifactStore:f.artifactStore}).recordRecovery({taskRunId:f.task.id});
    assert.equal(o.payload.failureLesson.control?.kind,"verification_repair");
    assert.match(o.payload.failureLesson.symptom,/unsupported immediate effect assumption/);
  }finally{await f.cleanup();}
});
test("real C# controls preserve accepted tests across repair and block weakened writes and deletes", real, async () => {
  const f = await fixture(source.replace("Value()=>7", "Value()=>0"));
  try {
    const contract = await f.register();
    await assert.rejects(f.check(contract), /exited|failed|실패/i);
    assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, true);
    await assert.rejects(f.edit("Verification.cs", "internal static class Program{static void Main(){}}"), /protected|보호/i);
    assert.equal(await readFile(join(f.project, "Verification.cs"), "utf8"), validTest);
    await f.edit("Api.cs", source);
    await f.check(contract);
    const gate = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireBuild: false, requireTests: true, requireSmoke: false });
    assert.notEqual(gate.status, "not_run"); assert.notEqual(gate.status, "failed");
    // A direct write bypassing the file runner cannot manufacture a current pass.
    await writeFile(join(f.project, "Verification.cs"), "internal static class Program{static void Main(){}}");
    await assert.rejects(f.runner.prepareRegressionCheck({ taskRunId: f.task.id, contractId: contract.id }), /protected|보호/i);
    const stale = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(stale.status, "not_run");
    await f.edit("Verification.cs", validTest); // Exact restoration is allowed.
    await f.check(contract);
    const step = await f.state.createStep({ taskRunId: f.task.id, index: 100, kind: "approval", title: "delete", status: "pending" });
    const cp = await f.state.createCheckpoint({ taskRunId: f.task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "delete" });
    const a = await f.state.createApproval({ taskRunId: f.task.id, checkpointId: cp.id, actionType: "file_delete", actionSummary: "delete tests",
      proposedAction: { type: "file_delete", fileDelete: await inspectDeleteFile(f.project,"Verification.cs") } });
    await f.approve(a); await assert.rejects(f.runner.executeApproved(a.id), /protected|보호/i);
  } finally { await f.cleanup(); }
});

for (const [name, program, corrected] of [
  ["async exception", `internal static class Program{static void Main(){try{_ = Api.GetAsync(null!);}catch(ArgumentNullException){return;}throw new Exception("Expected synchronous exception");}}`,
    `internal static class Program{static async Task Main(){try{await Api.GetAsync(null!);}catch(ArgumentNullException){return;}throw new Exception("Expected async exception");}}`],
  ["trailing CR", `internal static class Program{static void Main(){try{Api.Read("{}"+(char)13);}catch(InvalidDataException){return;}throw new Exception("Expected invalid JSON");}}`,
    `internal static class Program{static void Main(){var text="{}"+(char)13;if(Api.Read(text)!=text)throw new Exception("Expected valid JSON whitespace");}}`],
  ["snapshot equality", `internal static class Program{static void Main(){if(!Equals(Api.Capture(),Api.Capture()))throw new Exception("Expected record equality");}}`,
    `internal static class Program{static void Main(){var a=Api.Capture();var b=Api.Capture();if(a.Revision!=b.Revision||!a.Values.OrderBy(x=>x.Key).SequenceEqual(b.Values.OrderBy(x=>x.Key)))throw new Exception("Expected same contents");}}`],
]) {
  test(`real normal-reference execution rejects a false-positive ${name} assertion`, real, async () => {
    const f = await fixture(source, program);
    try {
      const contract = await f.register();
      await assert.rejects(f.check(contract), /exited|failed|실패/i);
      assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, false);
      const artifacts = await f.state.listArtifactsByTaskRun(f.task.id);
      assert.ok(artifacts.some(a => a.summary?.includes("reference")), "reference execution must be distinguished from candidate failure");
      const result = artifacts.find(a=>a.kind==="test_result");
      const output = await f.artifactStore.read({taskRunId:f.task.id,artifactId:result.id,kind:result.kind});
      assert.match(output,/Unhandled exception\. System\.Exception: Expected/);
      assert.doesNotMatch(output,/error CS\d+/);
      // The false assertion is not frozen; a corrected regression is editable.
      await f.edit("Verification.cs", corrected);
      await f.check(contract);
      assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, true);
    } finally { await f.cleanup(); }
  });
}
