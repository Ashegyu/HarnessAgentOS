import { AGENT_INVALID_OUTPUT } from "@harness/core";
import { AgentCliError } from "./model-cli-errors.ts";
import type { ModelTokenUsage } from "./model-cli-types.ts";
import { DEFAULT_MAX_CLI_STDOUT_BYTES } from "./agent-stream-limits.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Codex exec 0.153.x emits cumulative thread totals, not token deltas. */
export const parseCodexTokenUsage = (value: unknown): ModelTokenUsage | undefined => {
  if (!record(value) || !count(value.input_tokens) || !count(value.output_tokens)) return undefined;
  const cached = value.cached_input_tokens ?? 0;
  const reasoning = value.reasoning_output_tokens ?? 0;
  if (!count(cached) || !count(reasoning) || cached > value.input_tokens ||
      reasoning > value.output_tokens || !count(value.input_tokens + value.output_tokens)) return undefined;
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens,
    cachedInputTokens: cached, reasoningOutputTokens: reasoning };
};

/** Bounded JSONL framing + terminal state. No state is reconstructed from log tails. */
export class CodexExecStream {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private pendingBytes = 0;
  private discardedFrame = false;
  private decodeFailed = false;
  private finished = false;
  private failure: string | undefined;
  private finalText = "";
  private completed = false;
  private terminalSignature: string | undefined;
  private usage: ModelTokenUsage | undefined;
  private readonly maxFrameBytes: number;
  private readonly maxFinalBytes: number;

  constructor(private readonly options: {
    maxFrameBytes?: number;
    maxFinalBytes?: number;
    onFrame?: (event: Record<string, unknown>) => void;
  } = {}) {
    this.maxFrameBytes = Math.max(1, options.maxFrameBytes ?? DEFAULT_MAX_CLI_STDOUT_BYTES);
    this.maxFinalBytes = Math.max(1, options.maxFinalBytes ?? DEFAULT_MAX_CLI_STDOUT_BYTES);
  }

  write(bytes: Uint8Array): string {
    if (this.decodeFailed || this.finished) return "";
    try {
      const text = this.decoder.decode(bytes, { stream: true });
      this.feed(text);
      return text;
    } catch {
      this.decodeFailed = true;
      this.fail("Invalid UTF-8 in Codex JSONL output");
      return "";
    }
  }

  /** Flush decoder and a valid non-newline-terminated frame at EOF. */
  end(): string {
    if (this.finished) return "";
    this.finished = true;
    let tail = "";
    if (!this.decodeFailed) {
      try { tail = this.decoder.decode(); this.feed(tail); }
      catch { this.fail("Incomplete UTF-8 at Codex output EOF"); }
    }
    this.frame();
    return tail;
  }

  result(): { text: string; tokenUsage?: ModelTokenUsage } {
    if (!this.finished) throw new Error("Codex stream must reach EOF before result validation");
    const reason = this.failure ?? (!this.completed ? "Missing Codex turn.completed event"
      : !this.finalText.trim() ? "Missing final Codex assistant message" : undefined);
    if (reason) throw new AgentCliError(AGENT_INVALID_OUTPUT, "model_invalid", reason);
    const tokenUsage = this.tokenUsage;
    return { text: this.finalText, ...(tokenUsage ? { tokenUsage } : {}) };
  }

  /** Usage is independent of answer text, but never authoritative for an incomplete stream. */
  get tokenUsage(): ModelTokenUsage | undefined {
    return this.finished && !this.failure && this.completed && this.usage
      ? { ...this.usage } : undefined;
  }

  private fail(reason: string): void { this.failure ??= reason; }

  private feed(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const part = text.slice(offset, newline < 0 ? text.length : newline);
      if (!this.discardedFrame) {
        this.pendingBytes += Buffer.byteLength(part, "utf8");
        if (this.pendingBytes > this.maxFrameBytes) {
          this.fail("Codex JSONL frame exceeds the configured byte limit");
          this.pending = "";
          this.discardedFrame = true;
        } else { this.pending += part; }
      }
      if (newline < 0) break;
      this.frame();
      offset = newline + 1;
    }
  }

  private frame(): void {
    const line = this.pending.trim();
    const discarded = this.discardedFrame;
    this.pending = "";
    this.pendingBytes = 0;
    this.discardedFrame = false;
    if (discarded || !line) return;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { this.fail("Invalid or truncated Codex JSONL frame"); return; }
    if (!record(event) || typeof event.type !== "string") {
      this.fail("Invalid Codex JSONL event envelope"); return;
    }
    this.options.onFrame?.(event);
    if (event.type === "error" || event.type === "turn.failed") {
      this.fail("Codex reported an error or failed turn");
    } else if (event.type === "turn.started") {
      this.completed = false;
      this.finalText = "";
      this.terminalSignature = undefined;
    } else if (event.type === "turn.completed") {
      const signature = JSON.stringify(event);
      if (this.completed) {
        if (signature !== this.terminalSignature) this.fail("Conflicting Codex terminal events");
        return;
      }
      this.completed = true;
      this.terminalSignature = signature;
      // usage_from_last_total in Codex's JSONL emitter includes earlier turns.
      // Replace, never sum; a missing latest total invalidates earlier partial usage.
      this.usage = parseCodexTokenUsage(event.usage);
    } else if (event.type === "item.completed") {
      const item = event.item;
      if (!record(item) || !["agent_message", "assistant_message"].includes(String(item.type)) ||
          (item.phase !== undefined && item.phase !== "final_answer")) return;
      if (this.completed) { this.fail("Assistant message arrived after Codex turn completion"); return; }
      const text = typeof item.text === "string" ? item.text
        : typeof item.content === "string" ? item.content
        : Array.isArray(item.content) ? item.content.map((part) => record(part) && typeof part.text === "string" ? part.text : "").join("") : "";
      if (Buffer.byteLength(text, "utf8") > this.maxFinalBytes) {
        this.fail("Codex final answer exceeds the configured byte limit"); return;
      }
      this.finalText = text;
    }
  }
}
