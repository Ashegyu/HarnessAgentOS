---
id: harness-repository-pattern
trigger: "when adding a new feature to HarnessAgentOS"
confidence: 0.95
domain: architecture
source: local-repo-analysis
---

# Follow the Repository Pattern for New Storage Tables

## Action

1. Create `packages/storage/src/repositories/{domain}-repository.ts`
2. Define a `{Domain}Repository` interface (methods only, no implementation details)
3. Define a private `{Domain}Row` interface for raw SQLite columns (snake_case)
4. Add row-to-domain mapping in `packages/storage/src/repositories/row-mappers.ts`
5. Add migration in `packages/storage/src/migrations.ts` (idempotent, applied at `openDb()`)
6. Export from `packages/storage/src/repositories/index.ts`

Naming rules:
- SQLite columns: `snake_case`
- Domain objects: `camelCase`
- JSON columns: `{name}_json` suffix

Repositories MUST NOT contain policy decisions — that belongs in services.

## Evidence

- All 10+ existing repositories follow this exact pattern
- `row-mappers.ts` is the single place for column↔field translation
- Migrations are idempotent to survive multiple `openDb()` calls safely
