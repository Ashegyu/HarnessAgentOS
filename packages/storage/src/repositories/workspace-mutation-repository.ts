import { randomUUID } from "node:crypto";
import type { HarnessDb } from "../db.ts";
import { nowIso } from "../id.ts";

export interface WorkspaceMutationState { generation: number; activeMutations: number }
export interface WorkspaceMutationRepository {
  begin(workspaceKey: string): Promise<string>;
  end(token: string): Promise<void>;
  get(workspaceKey: string): Promise<WorkspaceMutationState>;
  recoverAbandoned(): void;
}

export class SqliteWorkspaceMutationRepository implements WorkspaceMutationRepository {
  constructor(private readonly db: HarnessDb) {}

  async begin(workspaceKey: string): Promise<string> {
    if (!workspaceKey) throw new TypeError("Workspace identity is required");
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspace_validation_state(workspace_key,generation,active_mutations)
        VALUES(?,0,0) ON CONFLICT(workspace_key) DO NOTHING`).run(workspaceKey);
      this.db.prepare(`UPDATE workspace_validation_state SET generation=generation+1,
        active_mutations=active_mutations+1 WHERE workspace_key=?`).run(workspaceKey);
      const token = `mutation_${randomUUID()}`;
      this.db.prepare("INSERT INTO workspace_mutations(id,workspace_key,started_at) VALUES(?,?,?)").run(token, workspaceKey, nowIso());
      return token;
    }).immediate();
  }

  async end(token: string): Promise<void> {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT workspace_key FROM workspace_mutations WHERE id=?").get(token) as { workspace_key: string } | undefined;
      if (!row) return;
      this.db.prepare(`UPDATE workspace_validation_state SET generation=generation+1,
        active_mutations=active_mutations-1 WHERE workspace_key=? AND active_mutations>0`).run(row.workspace_key);
      this.db.prepare("DELETE FROM workspace_mutations WHERE id=?").run(token);
    }).immediate();
  }

  async get(workspaceKey: string): Promise<WorkspaceMutationState> { return this.getSync(workspaceKey); }

  getSync(workspaceKey: string): WorkspaceMutationState {
    const row = this.db.prepare("SELECT generation,active_mutations FROM workspace_validation_state WHERE workspace_key=?")
      .get(workspaceKey) as { generation: number; active_mutations: number } | undefined;
    return row ? { generation: row.generation, activeMutations: row.active_mutations } : { generation: 0, activeMutations: 0 };
  }

  recoverAbandoned(): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE workspace_validation_state SET generation=generation+1,active_mutations=0
        WHERE active_mutations>0 OR workspace_key IN (SELECT workspace_key FROM workspace_mutations)`).run();
      this.db.prepare("DELETE FROM workspace_mutations").run();
    }).immediate();
  }
}
