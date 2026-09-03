import type { AgentStreamEvent } from "@harness/core";

export const DEFAULT_MAX_CLI_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CLI_STDERR_BYTES = 1024 * 1024;
export const DEFAULT_MAX_NORMALIZED_EVENTS = 4_096;
export const DEFAULT_MAX_PERSISTED_STREAM_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_STREAM_EVENTS = 4_096;

export class BoundedTextBuffer {
  private readonly maxBytes: number;
  private readonly chunks: string[] = [];
  private readonly chunkBytes: number[] = [];
  private head = 0;
  private retainedBytes = 0;
  droppedBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, Math.trunc(maxBytes));
  }

  append(text: string): void {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes >= this.maxBytes) {
      this.droppedBytes += this.retainedBytes + bytes;
      const tail = utf8Tail(text, this.maxBytes);
      const tailBytes = Buffer.byteLength(tail, "utf8");
      this.droppedBytes -= tailBytes;
      this.chunks.length = 0;
      this.chunkBytes.length = 0;
      this.head = 0;
      this.retainedBytes = tailBytes;
      if (tail.length > 0) {
        this.chunks.push(tail);
        this.chunkBytes.push(tailBytes);
      }
      return;
    }

    this.chunks.push(text);
    this.chunkBytes.push(bytes);
    this.retainedBytes += bytes;
    this.trimHead(this.retainedBytes - this.maxBytes);
  }

  value(): string {
    return this.chunks.slice(this.head).join("");
  }

  private trimHead(bytesToDrop: number): void {
    let remaining = bytesToDrop;
    while (remaining > 0 && this.head < this.chunks.length) {
      const firstBytes = this.chunkBytes[this.head] ?? 0;
      if (firstBytes <= remaining) {
        remaining -= firstBytes;
        this.retainedBytes -= firstBytes;
        this.droppedBytes += firstBytes;
        this.head += 1;
        continue;
      }
      const current = this.chunks[this.head] ?? "";
      const retained = utf8Tail(current, firstBytes - remaining);
      const retainedByteLength = Buffer.byteLength(retained, "utf8");
      const dropped = firstBytes - retainedByteLength;
      this.chunks[this.head] = retained;
      this.chunkBytes[this.head] = retainedByteLength;
      this.retainedBytes -= dropped;
      this.droppedBytes += dropped;
      remaining = 0;
    }
    if (this.head > 1_024 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.chunkBytes.splice(0, this.head);
      this.head = 0;
    }
  }
}

export class BoundedAgentStreamEventBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly events: AgentStreamEvent[] = [];
  private readonly eventBytes: number[] = [];
  private head = 0;
  private retainedBytes = 0;
  droppedEvents = 0;
  droppedBytes = 0;

  constructor(options: { maxEvents: number; maxBytes: number }) {
    this.maxEvents = Math.max(1, Math.trunc(options.maxEvents));
    this.maxBytes = Math.max(1, Math.trunc(options.maxBytes));
  }

  push(event: AgentStreamEvent): void {
    const bytes = Buffer.byteLength(safeJson(event), "utf8");
    if (bytes > this.maxBytes) {
      this.droppedEvents += 1;
      this.droppedBytes += bytes;
      return;
    }
    this.events.push(event);
    this.eventBytes.push(bytes);
    this.retainedBytes += bytes;
    while (
      this.events.length - this.head > this.maxEvents ||
      this.retainedBytes > this.maxBytes
    ) {
      const dropped = this.eventBytes[this.head] ?? 0;
      this.retainedBytes -= dropped;
      this.droppedBytes += dropped;
      this.droppedEvents += 1;
      this.head += 1;
    }
    if (this.head > 1_024 && this.head * 2 > this.events.length) {
      this.events.splice(0, this.head);
      this.eventBytes.splice(0, this.head);
      this.head = 0;
    }
  }

  toArray(): AgentStreamEvent[] {
    return this.events.slice(this.head);
  }
}

const utf8Tail = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
