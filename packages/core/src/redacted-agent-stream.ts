import type { AgentStreamEvent } from "./types/agent-invocation.ts";
import { redactSecrets, redactSecretValues } from "./redact-secrets.ts";

type TextEvent = Extract<AgentStreamEvent, { type: "raw" | "assistant_text" }>;
interface TextChannel {
  text: string;
  depth: number;
  quoted: boolean;
  escaped: boolean;
}
interface PendingEvent { event: AgentStreamEvent; channel?: string; length?: number }

/** Bounded audit buffering; raw execution results never pass through this emitter. */
export const createRedactedAgentStream = (options: {
  emit: (event: AgentStreamEvent) => void;
  redactEvent?: (event: AgentStreamEvent) => AgentStreamEvent;
  maxPendingChars?: number;
  maxPendingEvents?: number;
}): { push: (event: AgentStreamEvent) => void; flush: () => void } => {
  const maxChars = Math.max(1, options.maxPendingChars ?? 64 * 1024);
  const maxEvents = Math.max(1, options.maxPendingEvents ?? 256);
  const redactEvent = options.redactEvent ?? (event => redactSecretValues(event) as AgentStreamEvent);
  const channels = new Map<string, TextChannel>();
  let pending: PendingEvent[] = [];
  let pendingChars = 0;
  let discarding = false;

  const flushPending = (omit = false): void => {
    const batch = pending;
    pending = [];
    pendingChars = 0;
    const remaining = new Map<string, number>();
    for (const entry of batch) if (entry.channel !== undefined) {
      remaining.set(entry.channel, (remaining.get(entry.channel) ?? 0) + 1);
    }
    const text = new Map([...channels].map(([key, value]) =>
      [key, omit ? "[stream text omitted: audit buffer limit]\n" : redactSecrets(value.text, Number.MAX_SAFE_INTEGER)] as const));
    // A failing telemetry callback must not retain/replay raw data or prevent
    // the invocation's outer resource cleanup from completing.
    if (!omit) channels.clear();
    else for (const value of channels.values()) value.text = "";
    const offsets = new Map<string, number>();
    for (const entry of batch) {
      if (entry.channel === undefined) {
        options.emit(entry.event);
        continue;
      }
      const key = entry.channel;
      const value = text.get(key) ?? "";
      const offset = offsets.get(key) ?? 0;
      const left = (remaining.get(key) ?? 1) - 1;
      const end = omit || left === 0 ? value.length : Math.min(value.length, offset + (entry.length ?? 0));
      options.emit(redactEvent({ ...entry.event, text: value.slice(offset, end) } as TextEvent));
      offsets.set(key, end);
      remaining.set(key, left);
    }
  };

  const flush = (): void => {
    flushPending();
    channels.clear();
    discarding = false;
  };

  const push = (event: AgentStreamEvent): void => {
    const terminal = event.type === "result" || event.type === "failed" || event.type === "cancelled";
    if (terminal) {
      flush();
      options.emit(redactEvent(event));
      return;
    }
    if (event.type !== "raw" && event.type !== "assistant_text") {
      const redacted = redactEvent(event);
      if (pending.length === 0) options.emit(redacted);
      else {
        pending.push({ event: redacted });
        if (pending.length > maxEvents) { flushPending(true); discarding = true; }
      }
      return;
    }
    // stdout, stderr and completed assistant messages have independent text.
    const key = `${event.invocationId}:${event.type === "raw" ? event.source : "assistant"}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = { text: "", depth: 0, quoted: false, escaped: false };
      channels.set(key, channel);
    }
    scan(channel, event.text);
    const boundary = (event.type === "assistant_text" || /\r?\n$/.test(event.text)) &&
      [...channels.values()].every(value => !value.quoted && value.depth === 0);
    if (discarding) {
      if (boundary) { channels.clear(); discarding = false; }
      return;
    }
    pending.push({ event: { ...event, text: "" }, channel: key, length: event.text.length });
    const overflow = pendingChars + event.text.length > maxChars || pending.length > maxEvents;
    if (!overflow) { channel.text += event.text; pendingChars += event.text.length; }
    if (overflow) {
      flushPending(true);
      discarding = !boundary;
      if (boundary) channels.clear();
    }
    else if (boundary) flushPending();
  };

  return { push, flush };
};

// Delay a split key/value until its JSON string/object or ordinary line ends.
const scan = (channel: TextChannel, text: string): void => {
  for (const character of text) {
    if (channel.quoted) {
      if (channel.escaped) channel.escaped = false;
      else if (character === "\\") channel.escaped = true;
      else if (character === '"') channel.quoted = false;
    } else if (character === '"') channel.quoted = true;
    else if (character === "{" || character === "[") channel.depth += 1;
    else if (character === "}" || character === "]") channel.depth = Math.max(0, channel.depth - 1);
  }
};
