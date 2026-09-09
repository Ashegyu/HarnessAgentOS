import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { LocalStateService } from "../../packages/storage/src/index.ts";
import { isUnmodifiedStarterDefinition } from "../../packages/storage/src/repositories/harness-package-repository.ts";
import { HarnessPackageService, matchStarterProfile } from "../../packages/orchestration/src/harness-package-service.ts";

const TARGET_TABLES = new Set(["harness_packages", "harness_binding_sets"]);

// Only hashes leave this function. Agent CLI env/secrets and conversation text are not logged.
const protectedTableHashes = db => Object.fromEntries(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({ name }) => !TARGET_TABLES.has(name))
    .map(({ name }) => {
      const escaped = name.replaceAll('"', '""');
      const rows = db.prepare(`SELECT * FROM "${escaped}"`).all().map(row => JSON.stringify(row)).sort();
      return [name, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
    }),
);

/** Offline, explicit maintenance only. Never called on startup or against an active task. */
export async function reconcileHarnesses(db) {
  if (db.inTransaction) throw new Error("Maintenance requires its own transaction");
  db.exec("BEGIN IMMEDIATE");
  try {
    const integrity = db.pragma("quick_check");
    if (integrity.length !== 1 || integrity[0].quick_check !== "ok" || db.pragma("foreign_key_check").length > 0) {
      throw new Error("Database integrity check failed; no harness changes applied");
    }
    const untouched = protectedTableHashes(db);
    const state = new LocalStateService(db);
    const service = new HarnessPackageService({ state });
    const before = await state.harnessPackages.list();
    await state.harnessPackages.ensureSeed();
    const definitions = await state.harnessPackages.list();
    const profiles = await state.agentProfiles.list();
    const repairedBindings = [];
    const preservedCustomPackages = definitions.filter(d => !isUnmodifiedStarterDefinition(d)).map(d => d.id);
    for (const set of await state.harnessBindingSets.list()) {
      const definition = definitions.find(d => d.id === set.packageId);
      if (!definition || !isUnmodifiedStarterDefinition(definition)) continue;
      const workflow = definition.workflows.find(w => w.id === set.workflowId);
      if (!workflow) continue;
      const bindings = set.bindings.map(binding => {
        // A remote endpoint has a separate capability contract. Do not reinterpret it as local.
        if (binding.remoteEndpointId) return binding;
        const agent = definition.agents.find(a => a.id === binding.harnessAgentRef);
        if (!agent) return binding;
        const profile = profiles.find(p => p.id === binding.agentProfileId);
        const actions = workflow.steps.filter(s => s.agentRef === agent.id).flatMap(s => s.allowedActions);
        if (profile?.role === agent.roleHint && actions.every(action => !profile.permissions.blockedActions.includes(action))) return binding;
        const replacement = matchStarterProfile(definition, agent.id, agent.name, profiles);
        if (!replacement) return binding;
        repairedBindings.push({ bindingSetId: set.id, packageId: definition.id, role: agent.roleHint,
          fromProfileId: binding.agentProfileId, toProfileId: replacement.id });
        return { ...binding, agentProfileId: replacement.id };
      });
      if (!isDeepStrictEqual(bindings, set.bindings)) await service.saveBindingSet({ ...set, bindings });
    }
    const seeded = await service.ensureStarterBindingSets();
    const sets = await state.harnessBindingSets.list();
    const unreadyRoutes = [];
    const warnings = [];
    for (const set of sets) {
      const preview = await service.previewPipelineDraft({ packageId: set.packageId, workflowId: set.workflowId, bindings: set.bindings });
      if (!preview.ok) unreadyRoutes.push({ bindingSetId: set.id, issues: preview.issues });
      const issues = preview.readiness?.issues.filter(i => i.severity === "warning") ?? [];
      if (issues.length > 0) warnings.push({ bindingSetId: set.id, issues });
    }
    const missingBindings = definitions.flatMap(d => d.workflows
      .filter(w => !sets.some(s => s.packageId === d.id && s.workflowId === w.id))
      .map(w => ({ packageId: d.id, workflowId: w.id })));
    if (!isDeepStrictEqual(untouched, protectedTableHashes(db))) throw new Error("Unrelated database tables changed; rolling back");
    if (db.pragma("foreign_key_check").length > 0) throw new Error("Foreign key check failed; rolling back");
    const result = { packageCount: definitions.length, bindingSetCount: sets.length,
      newPackages: definitions.filter(d => !before.some(old => old.id === d.id)).map(d => ({ id: d.id, name: d.name, steps: d.workflows[0].steps.length })),
      updatedPackages: definitions.filter(d => { const old = before.find(b => b.id === d.id); return old && !isDeepStrictEqual(old, d); }).map(d => ({ id: d.id, name: d.name })),
      repairedBindings, newBindings: seeded.created.map(set => ({ id: set.id, packageId: set.packageId })),
      preservedCustomPackages, unreadyRoutes, missingBindings, warnings,
      unrelatedTablesUnchanged: true, protectedTableCount: Object.keys(untouched).length };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

async function main() {
  const [inputPath, mode = "--dry-run"] = process.argv.slice(2);
  if (!inputPath || !["--dry-run", "--apply"].includes(mode) || process.argv.length > 4) {
    throw new Error("Usage: reconcile-harnesses.mjs <existing app.db> [--dry-run|--apply]. Close HarnessAgentOS before --apply.");
  }
  const filePath = resolve(inputPath);
  const source = new Database(filePath, { readonly: true, fileMustExist: true });
  let copyPath;
  try {
    if (mode === "--apply") {
      const backupDir = join(dirname(filePath), "backups");
      await mkdir(backupDir, { recursive: true });
      // Atomic directory creation prevents overwriting any earlier backup.
      const runDir = await mkdtemp(join(backupDir, "harness-config-"));
      copyPath = join(runDir, "before.db");
    } else {
      copyPath = join(await mkdtemp(join(tmpdir(), "hgos-harness-audit-")), "copy.db");
    }
    await source.backup(copyPath);
  } finally { source.close(); }
  const target = new Database(mode === "--apply" ? filePath : copyPath, { fileMustExist: true });
  try {
    target.pragma("foreign_keys = ON");
    target.pragma("busy_timeout = 5000");
    target.pragma("journal_mode = WAL");
    const result = await reconcileHarnesses(target);
    console.log(JSON.stringify({ mode, filePath, copyPath, ...result }, null, 2));
  } finally { target.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
