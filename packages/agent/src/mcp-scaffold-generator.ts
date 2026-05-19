import type {
  GeneratedFileProposal,
  GeneratedMcpServerScaffoldDraft,
  McpServerScaffoldGenerationRequest,
} from "@harness/core";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "mcp",
  "server",
  "tool",
  "create",
  "build",
]);

export const buildGeneratedMcpServerScaffoldDraft = (
  request: McpServerScaffoldGenerationRequest,
): GeneratedMcpServerScaffoldDraft => {
  const intent = compactWhitespace(request.userIntent);
  const slug = sanitizeSlug(request.slug ?? slugFromIntent(intent));
  const name = nameFromSlug(slug);
  const files = buildFiles({ name, slug, intent });
  return {
    name,
    slug,
    targetDir: request.targetDir,
    files,
    recommendedCommand: `cd ${slug} && npm install && npm test && npm run build`,
    rationale:
      "Generated as approval-gated file proposals only; no scaffold files are written until the user approves and runs the file_write approvals.",
    warnings: [
      "Generated stdio MCP servers must not write normal logs to stdout; use stderr for diagnostics.",
      "The scaffold includes a placeholder tool implementation that must be replaced with project-specific logic before enablement.",
      "Run the smoke test before registering the server in Claude MCP config.",
    ],
  };
};

const buildFiles = (input: {
  name: string;
  slug: string;
  intent: string;
}): GeneratedFileProposal[] => [
  {
    path: `${input.slug}/package.json`,
    content: packageJson(input),
    rationale: "Node package metadata and MCP SDK dependency.",
    riskLevel: "low",
  },
  {
    path: `${input.slug}/tsconfig.json`,
    content: tsconfigJson(),
    rationale: "Strict TypeScript build settings for the stdio server.",
    riskLevel: "low",
  },
  {
    path: `${input.slug}/src/index.ts`,
    content: serverSource(input),
    rationale: "Minimal stdio MCP server with one placeholder tool.",
    riskLevel: "medium",
  },
  {
    path: `${input.slug}/README.md`,
    content: readme(input),
    rationale: "Operator instructions and approval boundary notes.",
    riskLevel: "low",
  },
  {
    path: `${input.slug}/tests/smoke.test.mjs`,
    content: smokeTest(input),
    rationale: "Smoke test and stdout logging guard for stdio transport.",
    riskLevel: "low",
  },
];

const packageJson = (input: { slug: string }): string =>
  `${JSON.stringify(
    {
      name: input.slug,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "node --test tests/*.test.mjs",
        start: "node dist/index.js",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.0.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
      },
    },
    null,
    2,
  )}\n`;

const tsconfigJson = (): string =>
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "dist",
        rootDir: "src",
        strict: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  )}\n`;

const serverSource = (input: {
  name: string;
  slug: string;
  intent: string;
}): string => `#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: ${JSON.stringify(input.slug)},
  version: "0.1.0",
});

server.registerTool(
  "placeholder_search",
  {
    title: "Placeholder Search",
    description: ${JSON.stringify(`Placeholder tool for ${input.intent || input.name}. Replace with project-specific logic.`)},
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, limit }) => {
    console.error(\`placeholder_search invoked: query=\${query} limit=\${limit}\`);
    return {
      content: [
        {
          type: "text",
          text: "Replace placeholder_search with real MCP logic before enabling this server.",
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
`;

const readme = (input: {
  name: string;
  slug: string;
  intent: string;
}): string => `# ${input.name}

Generated stdio MCP scaffold.

Intent:
${input.intent || "(no intent provided)"}

## Local validation

\`\`\`bash
npm install
npm test
npm run build
\`\`\`

## Harness boundary

- This scaffold is created through Harness \`file_write\` approvals.
- Do not register or enable it until the placeholder tool is replaced and smoke-tested.
- Do not write normal logs to stdout. Stdio MCP uses stdout for JSON-RPC frames; diagnostics belong on stderr.
`;

const smokeTest = (input: { slug: string }): string => `import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("stdio server source does not use console.log", () => {
  const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
  assert.doesNotMatch(source, /console\\.log/);
});

test("package name is scaffold slug", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.name, ${JSON.stringify(input.slug)});
});
`;

const slugFromIntent = (intent: string): string => {
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 4);
  return words.length > 0 ? words.join("-") : "generated-mcp-server";
};

const sanitizeSlug = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 80) : "generated-mcp-server";
};

const nameFromSlug = (slug: string): string =>
  slug
    .split("-")
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(" ");

const compactWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();
