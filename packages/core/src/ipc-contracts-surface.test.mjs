import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { IPC_CHANNELS } from "./ipc-channels.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "contracts",
  "ipc-contracts.md",
);

const eventPublicMethods = new Map([
  ["taskRunChanged", "onTaskRunChanged"],
  ["agentStreamEvent", "onAgentStreamEvent"],
]);

const expectedPublicMethods = () => {
  const methods = [];
  for (const [namespace, verbs] of Object.entries(IPC_CHANNELS)) {
    for (const verb of Object.keys(verbs)) {
      const publicVerb =
        namespace === "events" ? eventPublicMethods.get(verb) : verb;
      if (!publicVerb) {
        throw new Error(`Missing public event method mapping for ${verb}`);
      }
      methods.push(`${namespace}.${publicVerb}`);
    }
  }
  return methods.sort();
};

const documentedPublicMethods = () => {
  const md = readFileSync(CONTRACTS_PATH, "utf8");
  const namespaces = new Set(Object.keys(IPC_CHANNELS));
  const methods = new Set();
  const re = /\b([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g;
  let match;
  while ((match = re.exec(md)) !== null) {
    const [, namespace, verb] = match;
    if (!namespaces.has(namespace)) continue;
    methods.add(`${namespace}.${verb}`);
  }
  return [...methods].sort();
};

test("ipc-contracts.md lists the exact renderer-facing IPC method surface", () => {
  assert.deepEqual(documentedPublicMethods(), expectedPublicMethods());
});
