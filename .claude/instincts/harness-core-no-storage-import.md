---
id: harness-core-no-storage-import
trigger: "when writing HarnessAgentOS code"
confidence: 0.99
domain: architecture
source: local-repo-analysis
---

# Core Services Must Never Import @harness/storage

## Action

Services in `packages/core` MUST NOT `import ... from "@harness/storage"`.

Instead:
- Define a narrow gateway interface listing only the methods the service needs
- Accept the gateway via constructor injection (`deps.state: MyGateway`)
- Tests substitute a fake implementation

Example pattern:
```ts
// In packages/core/src/my-domain/my-gateway.ts
export interface MyGateway {
  getTaskRun(id: string): Promise<TaskRun | null>;
}

// In the service
export class MyService {
  constructor(private deps: { state: MyGateway }) {}
}
```

## Evidence

- `ConversationStateGateway`, `TaskRunCompletionGateway` demonstrate this pattern
- The layer rule is enforced in `docs/engineering/conventions.md`
- Violations would create a circular/coupled dependency that breaks testability
