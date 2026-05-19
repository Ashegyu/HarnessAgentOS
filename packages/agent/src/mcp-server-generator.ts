import type {
  GeneratedMcpServerDraft,
  McpServerGenerationRequest,
  McpTransport,
} from "@harness/core";
import { createHash } from "node:crypto";

const URL_PATTERN = /https?:\/\/[^\s)"']+/i;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "mcp",
  "server",
  "tool",
  "please",
]);

export const buildGeneratedMcpServerDraft = (
  request: McpServerGenerationRequest,
): GeneratedMcpServerDraft => {
  const intent = compactWhitespace(request.userIntent);
  const transport = request.preferredTransport ?? inferTransport(intent);
  const summary = summarizeIntent(intent);
  const slug = slugFromIntent(intent);
  const name = nameFromIntent(intent, summary);
  const envSecretRefs = inferSecretRefs(intent, slug, transport);
  const base = {
    name,
    description: `Generated MCP server draft for ${summary}.`,
    transport,
    env: {},
    envSecretRefs,
    scope: request.profileIds && request.profileIds.length > 0
      ? "per-agent"
      : "global",
    enabled: false,
    recommendedProfileIds: [...(request.profileIds ?? [])],
    secretPlaceholders: Object.values(envSecretRefs),
    rationale:
      "Generated from user intent only; save, health check, and profile binding stay explicit user actions. Codex per-run MCP is limited to stdio/no-secret servers; secret refs and remote transports stay explicit provider-boundary warnings.",
  } satisfies Omit<GeneratedMcpServerDraft, "command" | "args" | "url">;

  if (transport === "stdio") {
    return {
      ...base,
      command: inferCommand(intent),
      args: inferArgs(intent),
    };
  }

  return {
    ...base,
    url: inferUrl(intent, transport),
  };
};

const compactWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const summarizeIntent = (intent: string): string => {
  if (intent.length === 0) return "a reusable MCP connection";
  const firstSentence = intent.split(/[.!?\n]/)[0]?.trim() ?? intent;
  return truncate(firstSentence, 120);
};

const inferTransport = (intent: string): McpTransport => {
  if (/\bsse\b|server-sent/i.test(intent)) return "sse";
  if (
    URL_PATTERN.test(intent) ||
    /\b(http|hosted|remote|endpoint)\b|원격|엔드포인트/i.test(intent)
  ) {
    return "http";
  }
  return "stdio";
};

const nameFromIntent = (intent: string, summary: string): string => {
  if (/github|깃허브/i.test(intent)) return "GitHub MCP";
  if (/filesystem|file system|files\b|파일|fs\b/i.test(intent)) {
    return "Filesystem MCP";
  }
  if (/browser|playwright|브라우저/i.test(intent)) return "Browser MCP";
  const words = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 3);
  if (words.length > 0) return `${words.map(titleCase).join(" ")} MCP`;
  return "Generated MCP";
};

const slugFromIntent = (intent: string): string => {
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 3);
  const hash = createHash("sha1")
    .update(intent || "generated-mcp")
    .digest("hex")
    .slice(0, 6);
  const base = words.length > 0 ? words.join("_") : "generated_mcp";
  return `${base}_${hash}`.replace(/_+/g, "_").slice(0, 48);
};

const inferCommand = (intent: string): string => {
  if (/github|깃허브/i.test(intent)) return "npx";
  if (/filesystem|file system|files\b|파일|fs\b/i.test(intent)) return "npx";
  if (/browser|playwright|브라우저/i.test(intent)) return "npx";
  return "<mcp-server-command>";
};

const inferArgs = (intent: string): string[] => {
  if (/github|깃허브/i.test(intent)) {
    return ["-y", "@modelcontextprotocol/server-github"];
  }
  if (/filesystem|file system|files\b|파일|fs\b/i.test(intent)) {
    return ["-y", "@modelcontextprotocol/server-filesystem", "<allowed-root>"];
  }
  if (/browser|playwright|브라우저/i.test(intent)) {
    return ["-y", "@playwright/mcp@latest"];
  }
  return ["<mcp-server-args>"];
};

const inferUrl = (
  intent: string,
  transport: Exclude<McpTransport, "stdio">,
): string => {
  const match = URL_PATTERN.exec(intent);
  if (match?.[0]) return match[0].replace(/[.,;]+$/g, "");
  return transport === "sse"
    ? "https://mcp.example.com/sse"
    : "https://mcp.example.com/v1";
};

const inferSecretRefs = (
  intent: string,
  slug: string,
  transport: McpTransport,
): Record<string, string> => {
  if (!/\b(auth|oauth|token|api key|credential|bearer|github)\b|인증|토큰|키/i.test(intent)) {
    return {};
  }
  if (transport !== "stdio") return { AUTH: `${slug}_bearer_token` };
  if (/github|깃허브/i.test(intent)) {
    return { GITHUB_PERSONAL_ACCESS_TOKEN: "github_token" };
  }
  return { API_TOKEN: `${slug}_api_token` };
};

const titleCase = (value: string): string =>
  value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;

const truncate = (value: string, max: number): string => {
  const trimmed = compactWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}.`;
};
