import {
  isHarnessDefinition,
  type HarnessDefinition,
  type HarnessSourceFormat,
  type HarnessValidationStatus,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { nowIso } from "../id.ts";

export interface HarnessPackageRepository {
  list(): Promise<HarnessDefinition[]>;
  get(id: string): Promise<HarnessDefinition | null>;
  save(definition: HarnessDefinition): Promise<HarnessDefinition>;
  remove(id: string): Promise<void>;
}

interface HarnessPackageRow {
  id: string;
  name: string;
  source_format: string;
  root_dir: string;
  validation_status: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, source_format, root_dir, validation_status,
       definition_json, created_at, updated_at
  FROM harness_packages`;

export class SqliteHarnessPackageRepository
  implements HarnessPackageRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<HarnessDefinition[]> {
    const rows = this.db
      .prepare<[], HarnessPackageRow>(`${SELECT} ORDER BY updated_at DESC, id DESC`)
      .all();
    return rows.map(rowToDefinition);
  }

  async get(id: string): Promise<HarnessDefinition | null> {
    const row = this.db
      .prepare<[string], HarnessPackageRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToDefinition(row) : null;
  }

  async save(definition: HarnessDefinition): Promise<HarnessDefinition> {
    if (!isHarnessDefinition(definition)) {
      throw new Error("Invalid HarnessDefinition");
    }
    const now = nowIso();
    const existing = this.db
      .prepare<[string], { created_at: string }>(
        `SELECT created_at FROM harness_packages WHERE id = ?`,
      )
      .get(definition.id);
    const createdAt = existing?.created_at ?? now;
    const definitionJson = JSON.stringify(definition);
    this.db
      .prepare(
        `INSERT INTO harness_packages
          (id, name, source_format, root_dir, validation_status,
           definition_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           source_format = excluded.source_format,
           root_dir = excluded.root_dir,
           validation_status = excluded.validation_status,
           definition_json = excluded.definition_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        definition.id,
        definition.name,
        definition.source.format,
        definition.source.rootDir,
        definition.validation.status,
        definitionJson,
        createdAt,
        now,
      );
    return definition;
  }

  async remove(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM harness_packages WHERE id = ?`).run(id);
  }
}

const rowToDefinition = (row: HarnessPackageRow): HarnessDefinition => {
  const parsed = JSON.parse(row.definition_json) as unknown;
  if (!isHarnessDefinition(parsed)) {
    throw new Error(`Invalid HarnessDefinition stored for ${row.id}`);
  }
  if (parsed.id !== row.id) {
    throw new Error(`HarnessDefinition id mismatch for ${row.id}`);
  }
  if (parsed.name !== row.name) {
    throw new Error(`HarnessDefinition name mismatch for ${row.id}`);
  }
  if (parsed.source.format !== (row.source_format as HarnessSourceFormat)) {
    throw new Error(`HarnessDefinition source format mismatch for ${row.id}`);
  }
  if (parsed.source.rootDir !== row.root_dir) {
    throw new Error(`HarnessDefinition rootDir mismatch for ${row.id}`);
  }
  if (
    parsed.validation.status !==
    (row.validation_status as HarnessValidationStatus)
  ) {
    throw new Error(`HarnessDefinition validation status mismatch for ${row.id}`);
  }
  return parsed;
};
