import { resolve } from "node:path";
import { openDb, LocalStateService } from "../../packages/storage/src/index.ts";
import { HarnessPackageService } from "../../packages/orchestration/src/index.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Usage: audit-harnesses.mjs <existing app.db>");
const db = openDb({ filePath: resolve(dbPath), readonly: true });
try {
  const state = new LocalStateService(db);
  const service = new HarnessPackageService({ state });
  const definitions = await service.listPackages();
  const bindingSets = await service.listBindingSets();
  const profiles = await state.agentProfiles.list();
  const reports = [];
  for (const definition of definitions) {
    for (const workflow of definition.workflows) {
      const sets = bindingSets.filter(s => s.packageId === definition.id && s.workflowId === workflow.id);
      const routes = [];
      for (const set of sets) {
        const preview = await service.previewPipelineDraft({ packageId: definition.id, workflowId: workflow.id, bindings: set.bindings });
        routes.push({ id: set.id, name: set.name, ready: preview.ok,
          issues: [...(preview.readiness?.issues ?? []), ...preview.issues],
          bindings: set.bindings.map(b => ({ ref: b.harnessAgentRef, profileId: b.agentProfileId,
            profile: profiles.find(p => p.id === b.agentProfileId)?.name,
            role: profiles.find(p => p.id === b.agentProfileId)?.role,
            model: profiles.find(p => p.id === b.agentProfileId)?.tuning.model })),
        });
      }
      reports.push({ id: definition.id, name: definition.name, version: definition.version,
        validation: definition.validation, workflow: workflow.id, mode: workflow.mode,
        steps: workflow.steps.map(s => ({ id: s.id, ref: s.agentRef, role: s.roleHint,
          actions: s.allowedActions, contract: s.outputContract, dependsOn: s.dependsOn })), routes });
    }
  }
  console.log(JSON.stringify({ dbPath: resolve(dbPath), checkedAt: new Date().toISOString(),
    integrity: db.pragma("quick_check"), foreignKeys: db.pragma("foreign_key_check"),
    packageCount: definitions.length, bindingSetCount: bindingSets.length, profileCount: profiles.length,
    orphanBindingSets: bindingSets.filter(s => !definitions.some(d => d.id === s.packageId && d.workflows.some(w => w.id === s.workflowId))).map(s => s.id),
    profiles: profiles.map(p => ({ id: p.id, name: p.name, role: p.role, tags: p.tags, model: p.tuning.model,
      blocked: p.permissions.blockedActions, auto: p.permissions.autoApproveActions })),
    reports }, null, 2));
} finally { db.close(); }
