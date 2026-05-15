# Agent Topology Panel Design

## Goal

Add an operator-visible graph tab that shows how the selected TaskRun is moving through local agents, approvals, and optional A2A remote agents.

The panel is a renderer-only visualization over existing `TaskRunDetail` data. It must not introduce Express, localhost, WebSocket, or new canonical state.

## Data Sources

- `TaskRunDetail.taskRun`: root request and overall run status.
- `TaskRunDetail.steps`: orchestration and runner steps, including `Worker[...]` step titles.
- `TaskRunDetail.agentInvocations`: local CLI agent invocations and provider/model/status.
- `TaskRunDetail.a2aRemoteTaskRefs`: remote task state for invocations that crossed A2A.
- `TaskRunDetail.approvals`: pending or decided user gates.

## UI Placement

Add a new right-panel tab named `Graph` next to the existing `Agent` and `Timeline` tabs.

The existing Agent tab remains the detailed stream surface. The new Graph tab is a scanning surface: it should show connection state, active flow, blocked points, and remote links at a glance.

## Renderer Model

Create `agent-topology-model.ts` with a pure builder:

```ts
buildAgentTopology({
  taskRun,
  steps,
  invocations,
  approvals,
  remoteTaskRefs,
})
```

The builder returns:

- `nodes`: stable ids, labels, sublabels, status, kind, and fixed graph coordinates.
- `edges`: stable source/target ids, status, label, and animated flag.
- `summary`: counts of active, waiting, failed, remote, and completed nodes.

Node kinds:

- `request`
- `step`
- `agent`
- `approval`
- `remote`

Edge meanings:

- `starts`: request to first step or first agent.
- `runs`: step to agent invocation.
- `handoff`: sequential worker/agent flow.
- `remote`: local invocation to remote A2A task.
- `approval`: active node to approval gate.

## Status Mapping

Use a small renderer-local status vocabulary:

- `idle`
- `queued`
- `running`
- `waiting`
- `succeeded`
- `failed`
- `cancelled`

Mappings:

- Agent invocation `queued` -> `queued`
- Agent invocation `running` -> `running`
- Agent invocation `succeeded` -> `succeeded`
- Agent invocation `failed` -> `failed`
- Agent invocation `cancelled` -> `cancelled`
- Approval `pending` -> `waiting`
- Approval `rejected` -> `failed`
- A2A `working` / `submitted` -> `running`
- A2A `input-required` / `auth-required` -> `waiting`
- A2A `completed` -> `succeeded`
- A2A `failed` / `rejected` -> `failed`
- A2A `canceled` -> `cancelled`

## Visual Design

Use a compact operations-dashboard style:

- SVG graph with fixed responsive coordinates.
- Current or active edges use a subtle dash-flow animation.
- Running nodes use a restrained pulse ring.
- Node labels are single-line with ellipsis; full ids/details are available through `title`.
- A summary strip shows active, waiting, failed, remote, and completed counts.

No external graph library is required for the first version. A hand-authored SVG keeps the surface deterministic, small, and easy to test.

## Verification

1. Pure model tests:
   - local worker invocations become agent nodes in chronological order.
   - pending approvals become waiting nodes and approval edges.
   - A2A refs become remote nodes with attention status.
   - running handoff edges are animated.
2. Type check: `npm run check`.
3. Build: `npm run build`.
4. Full test: `npm run test` when `better_sqlite3.node` is not locked by a running Electron process.
