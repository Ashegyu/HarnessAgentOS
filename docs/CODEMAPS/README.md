# CODEMAPS

Flat lookup tables that map "where does X live?" for the HarnessAgentOS
monorepo. Treat these as load-bearing, machine-friendly indexes — when
they drift from the code, the next agent loses time.

| Map | Purpose |
|--|--|
| [desktop-ipc.md](desktop-ipc.md) | Renderer ↔ main IPC surface, namespace owners, event push wiring |
| [domain-flow.md](domain-flow.md) | Domain object repositories + TaskRun status / approval / quality gate transitions |

For prose architecture and design rationale, see [docs/architecture/](../architecture/) and [docs/implementation/](../implementation/).
