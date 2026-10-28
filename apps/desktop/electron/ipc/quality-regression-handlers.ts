import { err, harnessError, ok, STATE_INVALID_INPUT, type RegisterRegressionContractInput } from "@harness/core";
import type { RunnerService } from "@harness/runners";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export const buildRegressionHandler = (runner: RunnerService | undefined, changed: (id:string) => void,
  operation: "registerRegression" | "listRegressions" | "prepareRegression") => async (input: unknown) => {
  if (!runner || !isObject(input) || !isNonEmptyString(input.taskRunId)) return err(harnessError(STATE_INVALID_INPUT,"Invalid regression request"));
  try {
    const taskRunId = input.taskRunId;
    if (operation === "listRegressions") return ok(await runner.listRegressionContracts({taskRunId}));
    if (operation === "prepareRegression") {
      if (!isNonEmptyString(input.contractId)) return err(harnessError(STATE_INVALID_INPUT,"contractId is required"));
      const result = await runner.prepareRegressionCheck({taskRunId,contractId:input.contractId});
      changed(taskRunId);
      return ok(result);
    }
    if (input.manualConfirmation !== true || !isNonEmptyString(input.title) || !isNonEmptyString(input.referenceDir) ||
        ![input.sourcePaths,input.sharedPaths,input.verificationPaths].every(p => Array.isArray(p) && p.every(v => typeof v === "string"))) {
      return err(harnessError(STATE_INVALID_INPUT,"Confirm the trusted reference and specify C# input paths"));
    }
    const result = await runner.registerRegressionContract(input as unknown as RegisterRegressionContractInput);
    changed(taskRunId);
    return ok(result);
  } catch (error) { return err(harnessError(STATE_INVALID_INPUT,error instanceof Error ? error.message : String(error))); }
};


