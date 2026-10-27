import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const { z } = require("zod");
const uri = require("fast-uri");
const CachePolicy = require("http-cache-semantics");
const CacheableRequest = require("cacheable-request");
const { SourceMapConsumer } = require("source-map-js");

// Small deterministic inputs exercise upstream security fixes without starting
// a development server, exhausting memory or depending on wall-clock timing.
for (const kind of ["array", "set", "map"]) {
  test(`Zod rejects an oversized bounded ${kind} before visiting its elements`, () => {
    let visited = 0;
    const element = z.string().refine(() => { visited++; return true; });
    const values = Array.from({ length: 20 }, (_, i) => String(i));
    const schema = kind === "array" ? z.array(element).max(2)
      : kind === "set" ? z.set(element).max(2) : z.map(element, element).max(2);
    const input = kind === "array" ? values : kind === "set" ? new Set(values) : new Map(values.map(value => [value, value]));
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues.map(issue => issue.code), ["too_big"]);
    assert.equal(visited, 0, "the size bound must protect the element parser and issue allocations");
  });
}

for (const encoded of ["h%74tps://example.com/path", "jav%61script:alert(1)"]) {
  test(`URI normalization must not turn an encoded scheme into an active scheme: ${encoded}`, () => {
    assert.notEqual(uri.parse(encoded).scheme, encoded.startsWith("h") ? "https" : "javascript");
    assert.equal(uri.normalize(encoded), encoded);
    assert.equal(uri.normalize("https://example.com/%7e"), "https://example.com/~");
  });
}

test("private Set-Cookie responses are not storable by the download cache policy", () => {
  const request = { url: "https://example.com/private", method: "GET", headers: {} };
  const policy = new CachePolicy(request, { status: 200, headers: { "set-cookie": "fixture=session", "cache-control": "private, max-age=3600" } });
  assert.equal(policy.storable(), false);
});

for (const privateResponse of [true, false]) {
  test(`actual download cache ${privateResponse ? "refuses private responses even with max-stale" : "retains legitimate public cache hits"}`, async () => {
    const cache = new Map();
    let requests = 0;
    const cachedRequest = new CacheableRequest((_options, callback) => {
      requests++;
      const response = Readable.from(["fixture body"]);
      Object.assign(response, { statusCode: 200, url: "https://example.com/file", headers: {
        "set-cookie": "fixture=session", "cache-control": `${privateResponse ? "private" : "public"}, max-age=3600`,
      } });
      queueMicrotask(() => callback(response));
      return new EventEmitter();
    }, cache);
    for (let i = 0; i < 2; i++) {
      const response = await new Promise((resolve, reject) => cachedRequest({ protocol: "https:", hostname: "example.com", path: "/file",
        headers: i ? { "cache-control": "max-stale=99999" } : {} }, resolve).on("error", reject));
      let body = "";
      for await (const chunk of response) body += chunk;
      assert.equal(body, "fixture body");
      if (i) assert.equal(response.fromCache, !privateResponse);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(requests, privateResponse ? 2 : 1);
    assert.equal(cache.size, privateResponse ? 0 : 1);
  });
}

const indexed = (line, map = { version: 3, sources: [], names: [], mappings: "" }) => ({
  version: 3, sections: [{ offset: { line, column: 0 }, map }],
});
for (const line of [Infinity, 1.5, -1, 10_000_001]) {
  test(`indexed source maps reject unsafe section offsets before flattening: ${line}`, () => {
    assert.throws(() => new SourceMapConsumer(indexed(line)), /offset|integer/i);
    assert.doesNotThrow(() => new SourceMapConsumer(indexed(2)));
  });
}

test("nested indexed source-map offsets cannot bypass the aggregate bound", () => {
  assert.throws(() => new SourceMapConsumer(indexed(6_000_000, indexed(6_000_000))), /offset/i);
});

test("root, desktop, lockfile and installed Electron agree on the patched runtime", () => {
  const readJson = url => JSON.parse(readFileSync(url, "utf8"));
  const root = readJson(new URL("../../../package.json", import.meta.url));
  const desktop = readJson(new URL("../package.json", import.meta.url));
  const lock = readJson(new URL("../../../package-lock.json", import.meta.url));
  const version = root.devDependencies.electron;
  assert.match(version, /^\d+\.\d+\.\d+$/, "runtime upgrades must be pinned for native ABI verification");
  assert.equal(desktop.devDependencies.electron, version);
  assert.equal(lock.packages["node_modules/electron"].version, version);
  assert.equal(require("electron/package.json").version, version);
  assert.ok(require("semver").gte(version, "42.11.16"), "the audited 41.x runtime lacks the certificate mitigation");
});
