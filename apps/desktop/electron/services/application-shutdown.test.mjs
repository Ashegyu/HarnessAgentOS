import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installApplicationShutdown } from "./application-shutdown.ts";

const fixture = deps => {
  const app = new EventEmitter();
  let exits = 0;
  app.quit = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit("before-quit", event); if (!event.prevented) exits++; };
  installApplicationShutdown({ app, timeoutMs: 1000, ...deps });
  return { app, exits: () => exits };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test("quit seals once, waits for cleanup, closes storage once and permits the final quit", async () => {
  let release, drains = 0, closes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ drain: () => { drains++; return pending; }, close: () => { closes++; }, onError: assert.fail });
  f.app.quit(); f.app.quit(); await tick();
  assert.equal(drains, 1); assert.equal(closes, 0); assert.equal(f.exits(), 0);
  release(); await tick();
  assert.equal(closes, 1); assert.equal(f.exits(), 1);
});

test("a cleanup failure keeps storage open and can be retried without forcing an exit", async () => {
  let attempts = 0, closes = 0; const errors = [];
  const f = fixture({ drain: async () => { if (++attempts === 1) throw new Error("unconfirmed termination"); }, close: () => { closes++; }, onError: error => errors.push(error) });
  f.app.quit(); await tick();
  assert.equal(errors.length, 1); assert.equal(closes, 0); assert.equal(f.exits(), 0);
  f.app.quit(); await tick();
  assert.equal(closes, 1); assert.equal(f.exits(), 1);
});

test("timeout does not close storage or let late cleanup exit the app", async () => {
  let release, closes = 0; const errors = [];
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ timeoutMs: 10, drain: () => pending, close: () => { closes++; }, onError: error => errors.push(error) });
  f.app.quit(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(errors[0].message, /timed out/); assert.equal(closes, 0);
  release(); await tick(); assert.equal(f.exits(), 0); assert.equal(closes, 0);
  f.app.quit(); await tick(); assert.equal(f.exits(), 1); assert.equal(closes, 1);
});
