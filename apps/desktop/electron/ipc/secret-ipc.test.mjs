import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, SecretVaultService } from "@harness/storage";
import { buildSecretHandlers } from "./secret-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-secret-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const setupCtx = (file, { available = true } = {}) => {
  const db = openDb({ filePath: file });
  const backend = {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (b) => Buffer.isBuffer(b) ? b.toString("utf8").slice(4) : "",
  };
  const vault = new SecretVaultService(db, backend);
  return { db, ctx: { vault } };
};

test("secret.write persists then secret.listKeys returns the key", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSecretHandlers(ctx);
    const w = await h.write({ key: "OPENAI_KEY", value: "sk-test" });
    assert.equal(w.ok, true);
    const list = await h.listKeys();
    assert.equal(list.ok, true);
    assert.deepEqual(list.value, ["OPENAI_KEY"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("secret.clear removes the key", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSecretHandlers(ctx);
    await h.write({ key: "X", value: "v" });
    const r = await h.clear({ key: "X" });
    assert.equal(r.ok, true);
    const list = (await h.listKeys()).value;
    assert.equal(list.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("secret.write rejects empty key with STATE_INVALID_INPUT", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSecretHandlers(ctx);
    const r = await h.write({ key: "", value: "v" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("secret.write returns SECRET_VAULT_UNAVAILABLE when safeStorage is off", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file, { available: false });
  try {
    const h = buildSecretHandlers(ctx);
    const r = await h.write({ key: "X", value: "v" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "SECRET_VAULT_UNAVAILABLE");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("secret.listKeys works even when vault is unavailable (no plaintext involved)", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file, { available: false });
  try {
    const h = buildSecretHandlers(ctx);
    const r = await h.listKeys();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("buildSecretHandlers exposes write/clear/listKeys only (no read)", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildSecretHandlers(ctx);
    // The IPC surface MUST NOT expose plaintext to the renderer. This is
    // an architectural invariant — if a future refactor adds h.read here,
    // this test is the gate that stops it.
    assert.deepEqual(Object.keys(h).sort(), ["clear", "listKeys", "write"]);
    assert.equal("read" in h, false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
