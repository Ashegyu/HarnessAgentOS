import {
  isHarnessAgentProfileBinding,
  isHarnessBindingSet,
  type CreateHarnessBindingSetInput,
  type HarnessBindingSet,
  type HarnessBindingSetListInput,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export type SaveHarnessBindingSetInput =
  | CreateHarnessBindingSetInput
  | HarnessBindingSet;

export interface HarnessBindingSetRepository {
  list(input?: HarnessBindingSetListInput): Promise<HarnessBindingSet[]>;
  get(id: string): Promise<HarnessBindingSet | null>;
  save(input: SaveHarnessBindingSetInput): Promise<HarnessBindingSet>;
  remove(id: string): Promise<void>;
}

interface HarnessBindingSetRow {
  id: string;
  package_id: string;
  workflow_id: string;
  name: string;
  bindings_json: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, package_id, workflow_id, name, bindings_json,
       created_at, updated_at
  FROM harness_binding_sets`;

export class SqliteHarnessBindingSetRepository
  implements HarnessBindingSetRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(input: HarnessBindingSetListInput = {}): Promise<HarnessBindingSet[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (input.packageId !== undefined) {
      where.push("package_id = ?");
      params.push(input.packageId);
    }
    if (input.workflowId !== undefined) {
      where.push("workflow_id = ?");
      params.push(input.workflowId);
    }
    const sql = [
      SELECT,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY updated_at DESC, id DESC",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    const rows = this.db.prepare<string[], HarnessBindingSetRow>(sql).all(...params);
    return rows.map(rowToBindingSet);
  }

  async get(id: string): Promise<HarnessBindingSet | null> {
    const row = this.db
      .prepare<[string], HarnessBindingSetRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToBindingSet(row) : null;
  }

  async save(input: SaveHarnessBindingSetInput): Promise<HarnessBindingSet> {
    validateSaveInput(input);
    const now = nowIso();
    const inputId = "id" in input ? input.id : undefined;
    const id = inputId && inputId.length > 0 ? inputId : newId("harnessBindingSet");
    const existing = this.db
      .prepare<[string], { created_at: string }>(
        `SELECT created_at FROM harness_binding_sets WHERE id = ?`,
      )
      .get(id);
    const createdAt =
      existing?.created_at ??
      ("createdAt" in input && input.createdAt.length > 0
        ? input.createdAt
        : now);
    const saved: HarnessBindingSet = {
      id,
      packageId: input.packageId,
      workflowId: input.workflowId,
      name: input.name.trim(),
      bindings: input.bindings.map((binding) => ({ ...binding })),
      createdAt,
      updatedAt: now,
    };
    validateBindingSet(saved);
    this.db
      .prepare(
        `INSERT INTO harness_binding_sets
          (id, package_id, workflow_id, name, bindings_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           package_id = excluded.package_id,
           workflow_id = excluded.workflow_id,
           name = excluded.name,
           bindings_json = excluded.bindings_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        saved.id,
        saved.packageId,
        saved.workflowId,
        saved.name,
        JSON.stringify(saved.bindings),
        saved.createdAt,
        saved.updatedAt,
      );
    return saved;
  }

  async remove(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM harness_binding_sets WHERE id = ?`).run(id);
  }
}

const rowToBindingSet = (row: HarnessBindingSetRow): HarnessBindingSet => {
  const parsedBindings = JSON.parse(row.bindings_json) as unknown;
  const set: HarnessBindingSet = {
    id: row.id,
    packageId: row.package_id,
    workflowId: row.workflow_id,
    name: row.name,
    bindings: Array.isArray(parsedBindings) ? parsedBindings : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  validateBindingSet(set);
  return set;
};

const validateSaveInput = (input: SaveHarnessBindingSetInput): void => {
  if (input.packageId.trim().length === 0) {
    throw new Error("HarnessBindingSet.packageId must be non-empty");
  }
  if (input.workflowId.trim().length === 0) {
    throw new Error("HarnessBindingSet.workflowId must be non-empty");
  }
  if (input.name.trim().length === 0) {
    throw new Error("HarnessBindingSet.name must be non-empty");
  }
  if (!Array.isArray(input.bindings)) {
    throw new Error("HarnessBindingSet.bindings must be an array");
  }
  const refs = new Set<string>();
  for (const [i, binding] of input.bindings.entries()) {
    if (!isHarnessAgentProfileBinding(binding)) {
      throw new Error(`HarnessBindingSet.bindings[${i}] is malformed`);
    }
    const refKey = binding.harnessAgentRef.trim().toLowerCase();
    if (refs.has(refKey)) {
      throw new Error(
        `HarnessBindingSet.bindings[${i}].harnessAgentRef duplicates another binding`,
      );
    }
    refs.add(refKey);
  }
};

const validateBindingSet = (set: HarnessBindingSet): void => {
  if (!isHarnessBindingSet(set)) {
    throw new Error("Invalid HarnessBindingSet stored");
  }
};
