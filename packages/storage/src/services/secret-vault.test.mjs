import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import {
  SecretVaultService,
  SecretVaultUnavailableError,
} from "./secret-vault.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-vault-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

// In-memory test double for Electron's `safeStorage`. The vault must
// accept a pluggable backend so tests don't drag in the Electron module.
class InMemorySafeStorage {
  constructor({ available = true } = {}) {
    this._available = available;
  }
  isEncryptionAvailable() {
    return this._available;
  }
  encryptString(s) {
    // Trivial reversible scramble — confirms the vault wires through the
    // backend without leaking plaintext into the BLOB.
    return Buffer.from("enc:" + s, "utf8");
  }
  decryptString(b) {
    const s = Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    if (!s.startsWith("enc:")) throw new Error("invalid blob");
    return s.slice(4);
  }
}

test("SecretVault.write stores whatever the backend.encryptString returned", async () => {
  // The vault is platform-agnostic — it trusts safeStorage for the actual
  // encryption. We only verify that it called the backend and persisted
  // the resulting blob verbatim, never the plaintext.
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const backend = new InMemorySafeStorage();
    const vault = new SecretVaultService(db, backend);
    await vault.write("ANTHROPIC_API_KEY", "sk-ant-test-1234");
    const row = db
      .prepare("SELECT encrypted_blob FROM secrets WHERE key = ?")
      .get("ANTHROPIC_API_KEY");
    assert.ok(row.encrypted_blob instanceof Buffer);
    const expectedBlob = backend.encryptString("sk-ant-test-1234");
    assert.deepEqual(
      row.encrypted_blob,
      expectedBlob,
      "DB row must contain exactly the blob the backend produced",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.read returns the original plaintext via the backend", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const backend = new InMemorySafeStorage();
    const vault = new SecretVaultService(db, backend);
    await vault.write("OPENAI_API_KEY", "sk-openai-9999");
    const plain = await vault.read("OPENAI_API_KEY");
    assert.equal(plain, "sk-openai-9999");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.read returns null when the key is unknown", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const vault = new SecretVaultService(db, new InMemorySafeStorage());
    assert.equal(await vault.read("UNKNOWN"), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.clear removes the row", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const vault = new SecretVaultService(db, new InMemorySafeStorage());
    await vault.write("X", "value");
    await vault.clear("X");
    assert.equal(await vault.read("X"), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.listKeys returns names only, never values", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const vault = new SecretVaultService(db, new InMemorySafeStorage());
    await vault.write("A", "value-a");
    await vault.write("B", "value-b");
    const keys = await vault.listKeys();
    assert.deepEqual(keys.sort(), ["A", "B"]);
    // Verify the API surface never exposes plaintext through listKeys.
    assert.equal(typeof keys[0], "string");
    assert.ok(!keys.some((k) => k.includes("value-")));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.write refuses when encryption is unavailable", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const vault = new SecretVaultService(
      db,
      new InMemorySafeStorage({ available: false }),
    );
    await assert.rejects(
      () => vault.write("X", "value"),
      SecretVaultUnavailableError,
    );
    // listKeys still works (no plaintext involved) so the UI can render
    // the "vault disabled" banner without crashing.
    assert.deepEqual(await vault.listKeys(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.isAvailable mirrors the backend probe", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const on = new SecretVaultService(db, new InMemorySafeStorage());
    const off = new SecretVaultService(
      db,
      new InMemorySafeStorage({ available: false }),
    );
    assert.equal(on.isAvailable(), true);
    assert.equal(off.isAvailable(), false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("SecretVault.write overwrites an existing key", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const vault = new SecretVaultService(db, new InMemorySafeStorage());
    await vault.write("K", "first");
    await vault.write("K", "second");
    assert.equal(await vault.read("K"), "second");
    const keys = await vault.listKeys();
    assert.deepEqual(keys, ["K"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
