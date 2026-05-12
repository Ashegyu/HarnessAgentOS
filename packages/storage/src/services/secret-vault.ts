import type { HarnessDb } from "../db.ts";
import { nowIso } from "../id.ts";

/**
 * Pluggable backend so unit tests can use an in-memory scramble instead
 * of pulling in Electron. The main process wires this to the real
 * `safeStorage` module at boot.
 */
export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(blob: Buffer): string;
}

export class SecretVaultUnavailableError extends Error {
  constructor(message = "safeStorage backend is not available on this platform") {
    super(message);
    this.name = "SecretVaultUnavailableError";
  }
}

/**
 * Vault for renderer-owned secrets — see docs/design/agent-detailed-settings.md
 * §7. Plaintext flows IN via `write`, is encrypted by the platform-specific
 * backend, and stored as an opaque BLOB. The renderer is allowed to write,
 * clear, and list keys, but **never** to read plaintext — that surface is
 * intentionally main-process only via `read()`.
 */
export class SecretVaultService {
  private readonly db: HarnessDb;
  private readonly backend: SafeStorageBackend;

  constructor(db: HarnessDb, backend: SafeStorageBackend) {
    this.db = db;
    this.backend = backend;
  }

  isAvailable(): boolean {
    return this.backend.isEncryptionAvailable();
  }

  async write(key: string, plaintext: string): Promise<void> {
    if (!this.backend.isEncryptionAvailable()) {
      throw new SecretVaultUnavailableError();
    }
    const blob = this.backend.encryptString(plaintext);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO secrets (key, encrypted_blob, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           encrypted_blob = excluded.encrypted_blob,
           updated_at = excluded.updated_at`,
      )
      .run(key, blob, now, now);
  }

  /**
   * Main-process-only decrypt path. The IPC surface deliberately omits
   * this verb so the renderer can never request a plaintext secret.
   */
  async read(key: string): Promise<string | null> {
    const row = this.db
      .prepare<[string], { encrypted_blob: Buffer }>(
        `SELECT encrypted_blob FROM secrets WHERE key = ?`,
      )
      .get(key);
    if (!row) return null;
    if (!this.backend.isEncryptionAvailable()) {
      throw new SecretVaultUnavailableError();
    }
    return this.backend.decryptString(row.encrypted_blob);
  }

  async clear(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM secrets WHERE key = ?`).run(key);
  }

  async listKeys(): Promise<string[]> {
    const rows = this.db
      .prepare<[], { key: string }>(`SELECT key FROM secrets ORDER BY key ASC`)
      .all();
    return rows.map((r) => r.key);
  }
}
