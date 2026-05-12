import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteMcpServerRepository } from "./mcp-server-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-mcp-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeStdio = (overrides = {}) => ({
  name: "FS MCP",
  description: "",
  transport: "stdio",
  command: "/usr/local/bin/mcp-fs",
  args: ["--root", "/tmp"],
  env: { LOG_LEVEL: "info" },
  envSecretRefs: {},
  scope: "global",
  enabled: true,
  ...overrides,
});

test("McpServerRepository.list returns [] on an empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository.upsert creates a row when id is unknown", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert(makeStdio());
    assert.ok(created.id.startsWith("mcp_"));
    assert.equal(created.transport, "stdio");
    assert.equal(created.command, "/usr/local/bin/mcp-fs");
    assert.deepEqual(created.args, ["--root", "/tmp"]);
    assert.ok(created.createdAt);
    assert.equal(created.createdAt, created.updatedAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository.upsert updates in place when id exists", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert(makeStdio());
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.upsert({ ...created, name: "Renamed" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository.toggle flips enabled and bumps updatedAt", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert(makeStdio({ enabled: true }));
    const off = await repo.toggle(created.id, false);
    assert.equal(off.enabled, false);
    const on = await repo.toggle(created.id, true);
    assert.equal(on.enabled, true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository.delete removes the row", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert(makeStdio());
    await repo.delete(created.id);
    assert.equal(await repo.get(created.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository preserves http transport without command/args", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert({
      name: "Remote",
      description: "",
      transport: "http",
      url: "https://mcp.example.com/v1",
      env: {},
      envSecretRefs: { BEARER: "remote_token" },
      scope: "global",
      enabled: true,
    });
    const fetched = await repo.get(created.id);
    assert.equal(fetched.transport, "http");
    assert.equal(fetched.url, "https://mcp.example.com/v1");
    assert.equal(fetched.command, undefined);
    assert.equal(fetched.args, undefined);
    assert.equal(fetched.envSecretRefs.BEARER, "remote_token");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("McpServerRepository.recordHealth round-trips lastHealth", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteMcpServerRepository(db);
    const created = await repo.upsert(makeStdio());
    const stamped = await repo.recordHealth(created.id, {
      okAt: "2026-05-12T00:00:00.000Z",
      checkedAt: "2026-05-12T00:00:00.000Z",
    });
    assert.equal(stamped.lastHealth.okAt, "2026-05-12T00:00:00.000Z");
    const refreshed = await repo.get(created.id);
    assert.equal(refreshed.lastHealth.checkedAt, "2026-05-12T00:00:00.000Z");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
