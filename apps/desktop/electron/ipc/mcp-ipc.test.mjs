import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "@harness/storage";
import { buildMcpHandlers } from "./mcp-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-mcp-ipc-"));
  return {
    dir,
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

const profileInput = (overrides = {}) => ({
  name: "Reviewer",
  description: "",
  category: "review",
  tags: ["review"],
  provider: "claude",
  role: "reviewer",
  persona: "",
  tuning: {
    model: "claude-sonnet-4",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
    contextDepth: 5,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: false,
  ...overrides,
});

const setupCtx = (file, options = {}) => {
  const db = openDb({ filePath: file });
  const state = new LocalStateService(db);
  const mcp = state.mcpServers;
  const profiles = state.agentProfiles;
  const secretKeys = options.secretKeys ?? [];
  const probe = async (server) => {
    // Echo a stub health record so tests can assert handler behavior
    // without spawning anything.
    if (server.transport === "stdio" && server.command === "/bad") {
      return { error: "ENOENT", checkedAt: "2026-05-12T00:00:00.000Z" };
    }
    return { okAt: "2026-05-12T00:00:00.000Z", checkedAt: "2026-05-12T00:00:00.000Z" };
  };
  return {
    db,
    ctx: {
      state,
      mcp,
      profiles,
      probe,
      listSecretKeys: async () => secretKeys,
    },
  };
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

test("mcp.generateServerDraft returns preview without persisting a server", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.generateServerDraft({
      request: {
        userIntent: "GitHub MCP with token auth",
      },
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.draft.name, "GitHub MCP");
    assert.equal(r.value.preview.ok, true);
    assert.equal(r.value.preview.server.enabled, false);
    assert.match(r.value.preview.warnings.join("\n"), /Codex MCP config/);
    const list = await h.list();
    assert.deepEqual(list.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateServerDraft warns on sanitized name collision", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    await h.upsert({ server: stdio({ name: "GitHub MCP" }) });
    const r = await h.generateServerDraft({
      request: { userIntent: "GitHub server" },
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.preview.wouldNameCollide, true);
    assert.equal(r.value.preview.sanitizedConfigKey, "github_mcp");
    assert.match(r.value.preview.warnings.join("\n"), /already exists/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateServerDraft rejects invalid generation request", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.generateServerDraft({ request: { userIntent: "" } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateServerScaffoldDraft returns preview without writing files", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.generateServerScaffoldDraft({
      request: {
        userIntent: "repository search MCP",
        targetDir: t.dir,
      },
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.preview.ok, true);
    assert.equal(r.value.draft.files.length, 5);
    assert.equal(
      existsSync(join(t.dir, r.value.draft.files[0].path)),
      false,
    );
    assert.match(r.value.preview.warnings.join("\n"), /stdout/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.proposeServerScaffold creates pending file_write approvals without writing files", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const generated = await h.generateServerScaffoldDraft({
      request: {
        userIntent: "repository search MCP",
        targetDir: t.dir,
      },
    });

    const r = await h.proposeServerScaffold({
      draft: generated.value.draft,
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.approvals.length, generated.value.draft.files.length);
    assert.equal(r.value.approvals[0].actionType, "file_write");
    assert.equal(r.value.approvals[0].status, "pending");
    assert.match(
      r.value.approvals[0].proposedAction.filePatch.path,
      /package\.json$/,
    );
    assert.equal(
      existsSync(join(t.dir, generated.value.draft.files[0].path)),
      false,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateServerScaffoldDraft rejects relative targetDir", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const r = await h.generateServerScaffoldDraft({
      request: {
        userIntent: "repository search MCP",
        targetDir: "relative/path",
      },
    });

    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateProfileBindingProposal previews profile binding without updating AgentProfile", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const server = (await h.upsert({
      server: stdio({
        name: "Repo MCP",
        scope: "per-agent",
        lastHealth: {
          okAt: "2026-05-12T00:00:00.000Z",
          checkedAt: "2026-05-12T00:00:00.000Z",
        },
      }),
    })).value;
    const profile = await ctx.profiles.create(profileInput());

    const r = await h.generateProfileBindingProposal({
      request: { serverId: server.id, profileId: profile.id },
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.value.proposal.addMcpServerIds, [server.id]);
    assert.deepEqual(r.value.preview.before.mcpServerIds, []);
    assert.deepEqual(r.value.preview.after.mcpServerIds, [server.id]);
    const unchanged = await ctx.profiles.get(profile.id);
    assert.deepEqual(unchanged.mcpServerIds, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.generateProfileBindingProposal returns a no-op for global servers", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const server = (await h.upsert({
      server: stdio({ name: "Global MCP", scope: "global" }),
    })).value;
    const profile = await ctx.profiles.create(profileInput());

    const r = await h.generateProfileBindingProposal({
      request: { serverId: server.id, profileId: profile.id },
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.value.proposal.addMcpServerIds, []);
    assert.equal(r.value.preview.alreadySatisfied, true);
    assert.match(r.value.preview.warnings.join("\n"), /global MCP server/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.applyProfileBindingProposal updates only AgentProfile.mcpServerIds", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const server = (await h.upsert({
      server: stdio({
        name: "Repo MCP",
        scope: "per-agent",
        lastHealth: {
          okAt: "2026-05-12T00:00:00.000Z",
          checkedAt: "2026-05-12T00:00:00.000Z",
        },
      }),
    })).value;
    const profile = await ctx.profiles.create(
      profileInput({
        permissions: {
          autoApproveActions: [],
          blockedActions: [],
          allowedSkillIds: ["skill_review"],
          toolAllowlist: ["mcp__repo__read_*"],
          toolDenylist: ["mcp__repo__delete_*"],
        },
        skillSourceIds: ["ss_project"],
      }),
    );

    const r = await h.applyProfileBindingProposal({
      request: { serverId: server.id, profileId: profile.id },
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.value.profile.mcpServerIds, [server.id]);
    assert.deepEqual(r.value.profile.skillSourceIds, ["ss_project"]);
    assert.deepEqual(r.value.profile.permissions.allowedSkillIds, [
      "skill_review",
    ]);
    const persisted = await ctx.profiles.get(profile.id);
    assert.deepEqual(persisted.mcpServerIds, [server.id]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.applyProfileBindingProposal keeps global server bindings as a no-op", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const server = (await h.upsert({
      server: stdio({ name: "Global MCP", scope: "global" }),
    })).value;
    const profile = await ctx.profiles.create(profileInput());

    const r = await h.applyProfileBindingProposal({
      request: { serverId: server.id, profileId: profile.id },
    });

    assert.equal(r.ok, true);
    assert.equal(r.value.preview.alreadySatisfied, true);
    assert.deepEqual(r.value.profile.mcpServerIds, []);
    const persisted = await ctx.profiles.get(profile.id);
    assert.deepEqual(persisted.mcpServerIds, []);
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

test("mcp.upsert allows disabled servers with missing secret refs but rejects enabling them", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const draft = stdio({
      enabled: false,
      envSecretRefs: { API_TOKEN: "missing_token" },
    });

    const disabled = await h.upsert({ server: draft });
    assert.equal(disabled.ok, true);

    const enabled = await h.upsert({
      server: { ...disabled.value, enabled: true },
    });
    assert.equal(enabled.ok, false);
    assert.equal(enabled.error.code, "STATE_INVALID_INPUT");
    assert.match(enabled.error.message, /missing_token/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.upsert rejects enabling sanitized Claude config key collisions", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const first = await h.upsert({ server: stdio({ name: "GitHub MCP" }) });
    assert.equal(first.ok, true);
    const second = await h.upsert({
      server: stdio({ name: "github/mcp", enabled: false }),
    });
    assert.equal(second.ok, true);

    const r = await h.upsert({
      server: { ...second.value, enabled: true },
    });

    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
    assert.match(r.error.message, /github_mcp/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.toggle refuses to enable a server while referenced secrets are missing", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (
      await h.upsert({
        server: stdio({
          enabled: false,
          envSecretRefs: { API_TOKEN: "missing_token" },
        }),
      })
    ).value;

    const r = await h.toggle({ serverId: created.id, enabled: true });

    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
    assert.match(r.error.message, /missing_token/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.toggle refuses to enable sanitized Claude config key collisions", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const first = await h.upsert({ server: stdio({ name: "GitHub MCP" }) });
    assert.equal(first.ok, true);
    const second = (
      await h.upsert({
        server: stdio({ name: "github/mcp", enabled: false }),
      })
    ).value;

    const r = await h.toggle({ serverId: second.id, enabled: true });

    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
    assert.match(r.error.message, /github_mcp/);
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

test("mcp.healthCheck refuses to probe while referenced secrets are missing", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file);
  try {
    const h = buildMcpHandlers(ctx);
    const created = (
      await h.upsert({
        server: stdio({
          enabled: false,
          envSecretRefs: { API_TOKEN: "missing_token" },
        }),
      })
    ).value;

    const r = await h.healthCheck({ serverId: created.id });

    assert.equal(r.ok, false);
    assert.equal(r.error.code, "STATE_INVALID_INPUT");
    assert.match(r.error.message, /missing_token/);
    assert.equal((await h.list()).value[0].lastHealth, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("mcp.healthCheck allows probe when referenced secrets exist", async () => {
  const t = tmp();
  const { db, ctx } = setupCtx(t.file, { secretKeys: ["stored_token"] });
  try {
    const h = buildMcpHandlers(ctx);
    const created = (
      await h.upsert({
        server: stdio({
          enabled: false,
          envSecretRefs: { API_TOKEN: "stored_token" },
        }),
      })
    ).value;

    const r = await h.healthCheck({ serverId: created.id });

    assert.equal(r.ok, true);
    assert.equal(r.value.okAt, "2026-05-12T00:00:00.000Z");
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
