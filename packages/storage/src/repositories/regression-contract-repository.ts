import type { RegressionContractSummary } from "@harness/core";
import type { HarnessDb } from "../db.ts";

export interface RegressionSource { path: string; content: string }
export interface RegressionContract extends Omit<RegressionContractSummary, "protected"> {
  workspaceKey: string;
  sharedSources: RegressionSource[];
  referenceSources: RegressionSource[];
  protectedVerification: RegressionSource[] | null;
}
interface Row { definition_json: string; protected_verification_json: string | null }
const decode = (row: Row): RegressionContract => ({
  ...JSON.parse(row.definition_json),
  protectedVerification: row.protected_verification_json === null ? null : JSON.parse(row.protected_verification_json),
});

export class SqliteRegressionContractRepository {
  constructor(private readonly db: HarnessDb) {}
  async list(taskRunId: string): Promise<RegressionContract[]> {
    return (this.db.prepare("SELECT definition_json,protected_verification_json FROM regression_contracts WHERE task_run_id=? ORDER BY created_at,id")
      .all(taskRunId) as Row[]).map(decode);
  }
  async create(contract: RegressionContract): Promise<void> {
    this.db.transaction(() => {
      const task = this.db.prepare("SELECT status FROM task_runs WHERE id=?").get(contract.taskRunId) as {status:string} | undefined;
      if (!task || ["done","cancelled","paused"].includes(task.status)) throw new Error("Regression task is no longer active");
      this.db.prepare("INSERT INTO regression_contracts(id,task_run_id,workspace_key,definition_json,created_at) VALUES(?,?,?,?,?)")
        .run(contract.id, contract.taskRunId, contract.workspaceKey, JSON.stringify(contract), contract.createdAt);
      // Registration changes completion requirements, including for an already evaluated workspace.
      this.db.prepare(`INSERT INTO workspace_validation_state(workspace_key,generation,active_mutations) VALUES(?,1,0)
        ON CONFLICT(workspace_key) DO UPDATE SET generation=generation+1`).run(contract.workspaceKey);
    }).immediate();
  }
  async protect(id: string, sources: RegressionSource[]): Promise<void> {
    const encoded = JSON.stringify(sources);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT protected_verification_json FROM regression_contracts WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new Error("Regression contract not found");
      if (row.protected_verification_json !== null && row.protected_verification_json !== encoded) throw new Error("Protected regression changed");
      this.db.prepare("UPDATE regression_contracts SET protected_verification_json=? WHERE id=? AND protected_verification_json IS NULL").run(encoded,id);
    }).immediate();
  }
}
