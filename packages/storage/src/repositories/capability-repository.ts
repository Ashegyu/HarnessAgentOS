import type {
  Capability,
  CapabilityRiskLevel,
  CreateCapabilityInput,
} from "@harness/core";
import type { HarnessDb } from "../db";
import { newId } from "../id";

export interface CapabilityRepository {
  upsert(input: CreateCapabilityInput): Promise<Capability>;
  list(): Promise<Capability[]>;
  get(id: string): Promise<Capability | null>;
  removeBySource(source: string, keepIds: string[]): Promise<void>;
}

interface CapabilityRow {
  id: string;
  source: string;
  name: string;
  description: string;
  trigger_terms_json: string;
  risk_level: CapabilityRiskLevel;
  requires_approval: number;
}

const rowToCapability = (r: CapabilityRow): Capability => {
  let triggerTerms: string[] = [];
  try {
    triggerTerms = JSON.parse(r.trigger_terms_json) as string[];
  } catch {
    triggerTerms = [];
  }
  return {
    id: r.id,
    source: r.source,
    name: r.name,
    description: r.description,
    triggerTerms,
    riskLevel: r.risk_level,
    requiresApproval: r.requires_approval === 1,
  };
};

export class SqliteCapabilityRepository implements CapabilityRepository {
  constructor(private readonly db: HarnessDb) {}

  async upsert(input: CreateCapabilityInput): Promise<Capability> {
    const id = input.id ?? newId("capability");
    const cap: Capability = {
      id,
      source: input.source,
      name: input.name,
      description: input.description,
      triggerTerms: input.triggerTerms,
      riskLevel: input.riskLevel,
      requiresApproval: input.requiresApproval,
    };
    this.db
      .prepare(
        `INSERT INTO capabilities(id, source, name, description, trigger_terms_json, risk_level, requires_approval)
         VALUES(@id, @source, @name, @description, @triggerTermsJson, @riskLevel, @requiresApproval)
         ON CONFLICT(id) DO UPDATE SET
           source=excluded.source,
           name=excluded.name,
           description=excluded.description,
           trigger_terms_json=excluded.trigger_terms_json,
           risk_level=excluded.risk_level,
           requires_approval=excluded.requires_approval`,
      )
      .run({
        id: cap.id,
        source: cap.source,
        name: cap.name,
        description: cap.description,
        triggerTermsJson: JSON.stringify(cap.triggerTerms),
        riskLevel: cap.riskLevel,
        requiresApproval: cap.requiresApproval ? 1 : 0,
      });
    return cap;
  }

  async list(): Promise<Capability[]> {
    const rows = this.db
      .prepare(
        `SELECT id, source, name, description, trigger_terms_json, risk_level, requires_approval
         FROM capabilities ORDER BY name ASC, id ASC`,
      )
      .all() as CapabilityRow[];
    return rows.map(rowToCapability);
  }

  async get(id: string): Promise<Capability | null> {
    const row = this.db
      .prepare(
        `SELECT id, source, name, description, trigger_terms_json, risk_level, requires_approval
         FROM capabilities WHERE id = ?`,
      )
      .get(id) as CapabilityRow | undefined;
    return row ? rowToCapability(row) : null;
  }

  async removeBySource(source: string, keepIds: string[]): Promise<void> {
    if (keepIds.length === 0) {
      this.db
        .prepare(`DELETE FROM capabilities WHERE source = ?`)
        .run(source);
      return;
    }
    const placeholders = keepIds.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM capabilities WHERE source = ? AND id NOT IN (${placeholders})`,
      )
      .run(source, ...keepIds);
  }
}
