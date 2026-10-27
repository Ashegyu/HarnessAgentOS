import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import { buildMcpHandlers, type McpIpcContext } from "./mcp-ipc.ts";

export const registerMcpIpc = (ctx: McpIpcContext): void => {
  const h = buildMcpHandlers(ctx);
  handleIpc(IPC_CHANNELS.mcp.list, async () => h.list());
  handleIpc(IPC_CHANNELS.mcp.generateServerDraft, async (_e, input) =>
    h.generateServerDraft(input),
  );
  handleIpc(IPC_CHANNELS.mcp.generateServerScaffoldDraft, async (_e, input) =>
    h.generateServerScaffoldDraft(input),
  );
  handleIpc(IPC_CHANNELS.mcp.proposeServerScaffold, async (_e, input) =>
    h.proposeServerScaffold(input),
  );
  handleIpc(
    IPC_CHANNELS.mcp.generateProfileBindingProposal,
    async (_e, input) => h.generateProfileBindingProposal(input),
  );
  handleIpc(
    IPC_CHANNELS.mcp.applyProfileBindingProposal,
    async (_e, input) => h.applyProfileBindingProposal(input),
  );
  handleIpc(IPC_CHANNELS.mcp.upsert, async (_e, input) => h.upsert(input));
  handleIpc(IPC_CHANNELS.mcp.delete, async (_e, input) => h.delete(input));
  handleIpc(IPC_CHANNELS.mcp.toggle, async (_e, input) => h.toggle(input));
  handleIpc(IPC_CHANNELS.mcp.healthCheck, async (_e, input) =>
    h.healthCheck(input),
  );
};
