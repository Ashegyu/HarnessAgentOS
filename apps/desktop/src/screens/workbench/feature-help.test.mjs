import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_HELP,
  FEATURE_HELP_GROUPS,
  FEATURE_HELP_ORDER,
  getFeatureHelp,
} from "./feature-help.ts";

test("feature help order covers every feature exactly once", () => {
  const featureIds = Object.keys(FEATURE_HELP).sort();
  const orderedIds = [...FEATURE_HELP_ORDER].sort();

  assert.deepEqual(orderedIds, featureIds);
  assert.equal(new Set(FEATURE_HELP_ORDER).size, FEATURE_HELP_ORDER.length);
});

test("feature help entries have user-facing content", () => {
  for (const id of FEATURE_HELP_ORDER) {
    const entry = getFeatureHelp(id);
    assert.equal(entry.id, id);
    assert.ok(entry.title.trim().length > 0);
    assert.ok(entry.summary.trim().length > 0);
    assert.ok(entry.location.trim().length > 0);
    assert.ok(entry.details.length >= 2);
  }
});

test("feature help groups only reference known feature ids", () => {
  const known = new Set(Object.keys(FEATURE_HELP));
  for (const group of FEATURE_HELP_GROUPS) {
    assert.ok(group.title.trim().length > 0);
    for (const id of group.ids) {
      assert.equal(known.has(id), true);
    }
  }
});
