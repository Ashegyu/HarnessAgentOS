---
id: harness-test-file-naming
trigger: "when writing tests for HarnessAgentOS"
confidence: 0.99
domain: testing
source: local-repo-analysis
---

# Use *.test.mjs for All Test Files

## Action

- Test files MUST end with `.test.mjs` (not `.test.ts` or `.test.tsx`)
- Place test files next to the source file they test
- Use Node's built-in test runner: `node --test --import tsx --enable-source-maps`
- Import the `.ts` source directly: `import { Foo } from "./foo.ts"`

Example: `packages/agent/src/agent-output-parser.test.mjs`

## Evidence

- The entire test suite (167+ tests) uses `.test.mjs` — zero `.test.ts` files exist
- Root `npm test` fans out via `--workspaces --if-present`
- tsx transforms TypeScript on the fly for Node test runner
