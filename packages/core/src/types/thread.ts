export interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /**
   * Claude CLI session UUID used to chain agent invocations within this
   * thread. Set by the agent planner on the first invocation; subsequent
   * runs `--resume` it so follow-up questions share conversation memory.
   * `undefined` until the first claude agent invocation completes.
   */
  agentSessionId?: string;
}

export interface CreateThreadInput {
  title: string;
  targetDir?: string;
}

export interface UpdateThreadInput {
  title?: string;
  targetDir?: string;
  archivedAt?: string | null;
  agentSessionId?: string | null;
}
