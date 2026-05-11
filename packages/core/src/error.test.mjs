import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as errors from "./error.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/core/src → 3 levels up reaches repo root.
const CONTRACTS_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "contracts",
  "ipc-contracts.md",
);

/**
 * Returns the union of every backtick-quoted, ALL_CAPS_SNAKE_CASE identifier
 * referenced inside the contracts document. We treat that as the authoritative
 * list of error-code names the renderer is allowed to depend on, then make
 * sure every one of them resolves to an actual exported constant.
 *
 * This is the assertion that the audit recommended — it would have caught
 * the `CAPABILITY_UNTRUSTED_SCRIPT` vs `CAPABILITY_UNTRUSTED_SKILL` and
 * `ORCH_PLAN_NOT_FOUND` vs `ORCHESTRATION_PLAN_NOT_FOUND` drifts.
 */
const scrapeCodesFromContracts = () => {
  const md = readFileSync(CONTRACTS_PATH, "utf8");
  const codes = new Set();
  const re = /`([A-Z][A-Z0-9_]+)`/g;
  let match;
  while ((match = re.exec(md)) !== null) {
    const candidate = match[1];
    if (candidate.length < 4) continue;
    if (!candidate.includes("_")) continue; // skip plain ALL CAPS words
    codes.add(candidate);
  }
  return codes;
};

const exportedValues = new Set(
  Object.values(errors).filter((v) => typeof v === "string"),
);

test("every error code referenced in ipc-contracts.md is exported by error.ts", () => {
  const referenced = scrapeCodesFromContracts();
  const known = exportedValues;
  // Allow a small allowlist for non-code ALL_CAPS strings (TaskRun status enum
  // names, etc.). Anything that *looks* like a HarnessError code (suffix
  // _NOT_FOUND / _REQUIRED / _BLOCKED / _FAILED / _INVALID / _MISSING /
  // _UNAVAILABLE / _MISMATCH / _TRAVERSAL / _DISABLED / _REJECTED / _STALL /
  // _TIMEOUT / _CANCELLED / _LIMITED / _UNTRUSTED) must resolve.
  const codeLike =
    /(_NOT_FOUND|_REQUIRED|_BLOCKED|_FAILED|_INVALID|_MISSING|_UNAVAILABLE|_MISMATCH|_TRAVERSAL|_DISABLED|_REJECTED|_STALL|_TIMEOUT|_CANCELLED|_LIMITED|_UNTRUSTED|_OUTSIDE_WORKSPACE|_TASK_NOT_FOUND|_BLOCKED|_NOTHING_TO_RESUME|_REASON_REQUIRED|_TYPE_MISMATCH|_UNAVAILABLE|_TRAVERSAL|_HIGH_RISK|_INVALID_PAYLOAD|_NOT_ALLOWED|_DB_ERROR|_INVALID_INPUT|_EMPTY_REQUEST|_INVALID_TARGET_DIR|_INVALID_STATE|_DONE_BLOCKED|_RISK_MESSAGE_REQUIRED|_EVIDENCE_MISSING|_REFRESH_FAILED|_PROVIDER_UNAVAILABLE|_PROPOSED_ACTION_INVALID|_INVOCATION_NOT_FOUND|_MODE_MISMATCH|_DIRECT_ACTION_BLOCKED)$/;
  const missing = [];
  for (const code of referenced) {
    if (!codeLike.test(code)) continue;
    if (!known.has(code)) missing.push(code);
  }
  assert.deepEqual(
    missing,
    [],
    `Docs reference error codes that error.ts does not export: ${missing.join(", ")}`,
  );
});

test("ORCH_* and CAPABILITY_UNTRUSTED_SCRIPT legacy aliases resolve to canonical codes", () => {
  // Backward-compat: short-form constants must keep working so existing
  // callers don't break, but they must alias the same string values as the
  // canonical long-form names.
  assert.equal(errors.ORCH_PLAN_NOT_FOUND, errors.ORCHESTRATION_PLAN_NOT_FOUND);
  assert.equal(
    errors.ORCH_APPROVAL_NOT_APPROVED,
    errors.ORCHESTRATION_APPROVAL_REQUIRED,
  );
  assert.equal(
    errors.ORCH_DIRECT_ACTION_BLOCKED,
    errors.ORCHESTRATION_DIRECT_ACTION_BLOCKED,
  );
  assert.equal(
    errors.CAPABILITY_UNTRUSTED_SCRIPT,
    errors.CAPABILITY_UNTRUSTED_SKILL,
  );
  assert.equal(errors.LEARNER_DECISION_INVALID, errors.LEARNER_INVALID_DECISION);
});

test("no error constant value collides with a different constant name", () => {
  // Catch accidental copy/paste duplicates where two names share the same
  // string value but mean different things.
  const valueToNames = new Map();
  for (const [name, value] of Object.entries(errors)) {
    if (typeof value !== "string") continue;
    if (!valueToNames.has(value)) valueToNames.set(value, []);
    valueToNames.get(value).push(name);
  }
  const offenders = [];
  for (const [value, names] of valueToNames) {
    if (names.length === 1) continue;
    // Aliases above (ORCH_*, CAPABILITY_UNTRUSTED_SCRIPT, LEARNER_DECISION_INVALID)
    // are intentional. Anything else is suspicious.
    const intentional = names.every((n) =>
      /^(ORCH_|CAPABILITY_UNTRUSTED_SCRIPT|LEARNER_DECISION_INVALID)/.test(n) ||
      /^ORCHESTRATION_|^CAPABILITY_UNTRUSTED_SKILL|^LEARNER_INVALID_DECISION/.test(n),
    );
    if (!intentional) offenders.push({ value, names });
  }
  assert.deepEqual(offenders, [], `Unexpected duplicate constant values: ${JSON.stringify(offenders)}`);
});
