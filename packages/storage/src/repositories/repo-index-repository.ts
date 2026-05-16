import type { RepoIndexFile, RepoIndexFileKind } from "@harness/core";
import type { HarnessDb } from "../db.ts";

export interface RepoIndexRepository {
  upsertMany(files: RepoIndexFile[]): Promise<void>;
  listByTarget(input: {
    projectKey: string;
    targetDir: string;
    limit?: number;
  }): Promise<RepoIndexFile[]>;
  deleteMissing(input: {
    projectKey: string;
    targetDir: string;
    keepRelativePaths: string[];
  }): Promise<void>;
}

interface RepoIndexRow {
  id: string;
  project_key: string;
  target_dir: string;
  relative_path: string;
  file_kind: RepoIndexFileKind;
  size_bytes: number;
  mtime_ms: number;
  content_hash: string;
  summary: string;
  symbols_json: string;
  imports_json: string;
  updated_at: string;
}

const parseStringArray = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
};

const rowToRepoIndexFile = (row: RepoIndexRow): RepoIndexFile => ({
  id: row.id,
  projectKey: row.project_key,
  targetDir: row.target_dir,
  relativePath: row.relative_path,
  fileKind: row.file_kind,
  sizeBytes: row.size_bytes,
  mtimeMs: row.mtime_ms,
  contentHash: row.content_hash,
  summary: row.summary,
  symbols: parseStringArray(row.symbols_json),
  imports: parseStringArray(row.imports_json),
  updatedAt: row.updated_at,
});

export class SqliteRepoIndexRepository implements RepoIndexRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async upsertMany(files: RepoIndexFile[]): Promise<void> {
    if (files.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO repo_index_files(
         id, project_key, target_dir, relative_path, file_kind, size_bytes,
         mtime_ms, content_hash, summary, symbols_json, imports_json, updated_at
       ) VALUES(
         @id, @projectKey, @targetDir, @relativePath, @fileKind, @sizeBytes,
         @mtimeMs, @contentHash, @summary, @symbolsJson, @importsJson, @updatedAt
       )
       ON CONFLICT(project_key, target_dir, relative_path) DO UPDATE SET
         file_kind=excluded.file_kind,
         size_bytes=excluded.size_bytes,
         mtime_ms=excluded.mtime_ms,
         content_hash=excluded.content_hash,
         summary=excluded.summary,
         symbols_json=excluded.symbols_json,
         imports_json=excluded.imports_json,
         updated_at=excluded.updated_at`,
    );
    const tx = this.db.transaction((rows: RepoIndexFile[]) => {
      for (const file of rows) {
        stmt.run({
          id: file.id,
          projectKey: file.projectKey,
          targetDir: file.targetDir,
          relativePath: file.relativePath,
          fileKind: file.fileKind,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          contentHash: file.contentHash,
          summary: file.summary,
          symbolsJson: JSON.stringify(file.symbols),
          importsJson: JSON.stringify(file.imports),
          updatedAt: file.updatedAt,
        });
      }
    });
    tx(files);
  }

  async listByTarget(input: {
    projectKey: string;
    targetDir: string;
    limit?: number;
  }): Promise<RepoIndexFile[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 500, 5_000));
    const rows = this.db
      .prepare(
        `SELECT *
         FROM repo_index_files
         WHERE project_key = ? AND target_dir = ?
         ORDER BY relative_path ASC
         LIMIT ?`,
      )
      .all(input.projectKey, input.targetDir, limit) as RepoIndexRow[];
    return rows.map(rowToRepoIndexFile);
  }

  async deleteMissing(input: {
    projectKey: string;
    targetDir: string;
    keepRelativePaths: string[];
  }): Promise<void> {
    if (input.keepRelativePaths.length === 0) {
      this.db
        .prepare(
          `DELETE FROM repo_index_files
           WHERE project_key = ? AND target_dir = ?`,
        )
        .run(input.projectKey, input.targetDir);
      return;
    }
    const keep = new Set(input.keepRelativePaths);
    const existing = this.db
      .prepare(
        `SELECT relative_path
         FROM repo_index_files
         WHERE project_key = ? AND target_dir = ?`,
      )
      .all(input.projectKey, input.targetDir) as Array<{ relative_path: string }>;
    const stale = existing
      .map((row) => row.relative_path)
      .filter((relativePath) => !keep.has(relativePath));
    if (stale.length === 0) return;
    const stmt = this.db.prepare(
      `DELETE FROM repo_index_files
       WHERE project_key = ? AND target_dir = ? AND relative_path = ?`,
    );
    const tx = this.db.transaction((paths: string[]) => {
      for (const relativePath of paths) {
        stmt.run(input.projectKey, input.targetDir, relativePath);
      }
    });
    tx(stale);
  }
}
