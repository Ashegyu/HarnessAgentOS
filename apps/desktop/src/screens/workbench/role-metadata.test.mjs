import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_ROLES } from "@harness/core";
import {
  WORKER_ROLE_METADATA,
  roleLabel,
  roleOptionLabel,
} from "./role-metadata.ts";

test("WORKER_ROLE_METADATA documents every WorkerRole", () => {
  assert.deepEqual(
    Object.keys(WORKER_ROLE_METADATA).sort(),
    [...WORKER_ROLES].sort(),
  );
  for (const role of WORKER_ROLES) {
    const meta = WORKER_ROLE_METADATA[role];
    assert.ok(meta.label.length > 0, `${role} label`);
    assert.ok(meta.description.length > 0, `${role} description`);
    assert.ok(meta.whenToUse.length > 0, `${role} whenToUse`);
    assert.ok(roleOptionLabel(role).includes(role));
    assert.equal(roleLabel(role), meta.label);
  }
});
