import {
  DefaultModelCliAdapter,
  FakeModelCliAdapter,
  type FakeScenario,
} from "@harness/agent";

import type { CaseRunnerDeps } from "./case-runner.ts";

export interface EvalAdapterFactoryOptions {
  readonly realCli: boolean;
  readonly fakeChunkDelayMs?: number;
}

export const createEvalAdapterFactory = (
  options: EvalAdapterFactoryOptions,
): NonNullable<CaseRunnerDeps["adapterFactory"]> =>
  ({ testCase }) => {
    if (options.realCli) {
      return new DefaultModelCliAdapter();
    }
    return new FakeModelCliAdapter({
      scenario: testCase.scenario as FakeScenario,
      chunkDelayMs: options.fakeChunkDelayMs ?? 0,
    });
  };
