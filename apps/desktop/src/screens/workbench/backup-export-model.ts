import type { Thread } from "@harness/core";

export const backupDefaultDbFileName = (): string =>
  `harness-agent-os-snapshot-${dateStamp(new Date())}.db`;

export const threadMarkdownDefaultFileName = (thread: Thread | null): string => {
  const base = thread ? safeFileStem(thread.title) : "thread-export";
  return `${base}-${dateStamp(new Date())}.md`;
};

export const safeFileStem = (value: string): string => {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "thread-export";
};

const dateStamp = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
};
