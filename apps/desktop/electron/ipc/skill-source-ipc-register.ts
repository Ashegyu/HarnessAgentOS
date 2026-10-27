import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import {
  buildSkillSourceHandlers,
  type SkillSourceIpcContext,
} from "./skill-source-ipc.ts";

export const registerSkillSourceIpc = (ctx: SkillSourceIpcContext): void => {
  const h = buildSkillSourceHandlers(ctx);
  handleIpc(IPC_CHANNELS.skillSource.list, async () => h.list());
  handleIpc(IPC_CHANNELS.skillSource.add, async (_e, input) =>
    h.add(input),
  );
  handleIpc(IPC_CHANNELS.skillSource.update, async (_e, input) =>
    h.update(input),
  );
  handleIpc(IPC_CHANNELS.skillSource.remove, async (_e, input) =>
    h.remove(input),
  );
  handleIpc(IPC_CHANNELS.skillSource.refresh, async (_e, input) =>
    h.refresh(input),
  );
  handleIpc(
    IPC_CHANNELS.skillSource.generateSkillDraft,
    async (_e, input) => h.generateSkillDraft(input),
  );
  handleIpc(
    IPC_CHANNELS.skillSource.previewSkillDraft,
    async (_e, input) => h.previewSkillDraft(input),
  );
  handleIpc(
    IPC_CHANNELS.skillSource.proposeSkillFile,
    async (_e, input) => h.proposeSkillFile(input),
  );
  handleIpc(
    IPC_CHANNELS.skillSource.generateProfileBindingProposal,
    async (_e, input) => h.generateProfileBindingProposal(input),
  );
  handleIpc(
    IPC_CHANNELS.skillSource.applyProfileBindingProposal,
    async (_e, input) => h.applyProfileBindingProposal(input),
  );
};
