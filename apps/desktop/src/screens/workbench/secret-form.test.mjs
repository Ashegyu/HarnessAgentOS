import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptySecretDraft,
  validateSecretDraft,
} from "./secret-form.ts";

test("emptySecretDraft yields blank key/value", () => {
  const d = emptySecretDraft();
  assert.equal(d.key, "");
  assert.equal(d.value, "");
});

test("validateSecretDraft requires non-empty key", () => {
  const errs = validateSecretDraft({ key: "  ", value: "v" }, []);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "key");
});

test("validateSecretDraft requires non-empty value", () => {
  const errs = validateSecretDraft({ key: "API_TOKEN", value: "" }, []);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "value");
});

test("validateSecretDraft enforces key character whitelist", () => {
  // Vault keys are referenced from envSecretRefs which uses KEY=secret_vault_key
  // form. Disallow whitespace and '=' to keep parsing unambiguous.
  const errs = validateSecretDraft({ key: "bad key", value: "v" }, []);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "key");
});

test("validateSecretDraft flags duplicates against existing key list", () => {
  const errs = validateSecretDraft(
    { key: "existing", value: "v" },
    ["other", "existing"],
  );
  assert.equal(errs.length, 1);
  assert.equal(errs[0].field, "key");
  assert.match(errs[0].message, /이미/);
});

test("validateSecretDraft accepts well-formed draft", () => {
  assert.deepEqual(
    validateSecretDraft({ key: "fs_token", value: "s3cr3t" }, ["other"]),
    [],
  );
});
