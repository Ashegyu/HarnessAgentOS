import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, SqliteMcpServerRepository } from "@harness/storage";
import { buildMcpHandlers } from "./mcp-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-mcp-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const stdio = (overrides = {}) => ({
  name: "FS",
  description: "",
  transport: "stdio",
  command: "/usr/bin/mcp-fs",
  args: ["--root", "/tmp"],
  env: {},
  envSecretRefs: {},
  scope: "global",
  enabled: true,
  ...overrides,
});

const setupCtx = (file) => {
  const db = openDb({ filePath: file });
  const mcp = new SqliteMcpServerRepository(db);
  const probe = async (server) => {
    // Echo a stub health record so tests can assert handler behavior
    // without spawning anything.
    if (server.transport === "stdio" && server.command === "/bad") {
      return { error: "ENOENT", checkedAt: "2026-05-12T00:00:00.000Z" };
    }
    return { okAt: "2026-05-12T00:00:00.000Z", checkedAt: "2026-05-12T00:00:00.000Z" };
  };
  return { db, ctx: { mcp, probe } };
};

test("mcp.list returns ok([]) on a fresh DB", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.list();
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.upsert creates then updates the same row", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = await h.upsert({ server: stdio() });
    assert.equal(created.ok, true);
    assert.ok(created.value.id.startsWith("mcp_"));
    const renamed = await h.upsert({ server: { ...created.value, name: "Renamed" } });
    assert.equal(renamed.value.id, created.value.id);
    assert.equal(renamed.value.name, "Renamed");
    const list = (await h.list()).value;
    assert.equal(list.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.upsert rejects invalid transport via STATE_INVALID_INPUT", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.upsert({ server: { ...stdio(), transport: "telepathy" } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.toggle flips enabled", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (await h.upsert({ server: stdio({ enabled: true }) })).value;
    const off = await h.toggle({ serverId: created.id, enabled: false });
    assert.equal(off.value.enabled, false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.healthCheck stamps lastHealth via the probe", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (await h.upsert({ server: stdio() })).value;
    const r = await h.healthCheck({ serverId: created.id });
    assert.equal(r.ok, true);
    assert.equal(r.value.okAt, "2026-05-12T00:00:00.000Z");
    const refreshed = (await h.list()).value[0];
    assert.equal(refreshed.lastHealth.okAt, "2026-05-12T00:00:00.000Z");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.healthCheck returns probe.error when the server can't be reached", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (await h.upsert({ server: stdio({ command: "/bad" }) })).value;
    const r = await h.healthCheck({ serverId: created.id });
    assert.equal(r.ok, true);
    assert.equal(r.value.error, "ENOENT");
    assert.equal(r.value.okAt, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.delete removes the row", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (await h.upsert({ server: stdio() })).value;
    const r = await h.delete({ serverId: created.id });
    assert.equal(r.ok, true);
    const list = (await h.list()).value;
    assert.equal(list.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
