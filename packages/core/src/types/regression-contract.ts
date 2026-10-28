/** A user-supplied positive control. References are never inferred by a model. */
export interface RegisterRegressionContractInput {
  taskRunId: string;
  title: string;
  referenceDir: string;
  sourcePaths: string[];
  sharedPaths: string[];
  verificationPaths: string[];
  manualConfirmation: boolean;
}
export interface RegressionContractSummary {
  id: string;
  taskRunId: string;
  title: string;
  sourcePaths: string[];
  verificationPaths: string[];
  protected: boolean;
  createdAt: string;
}
export const regressionCheckerId = (id: string): string => `regression:${id}`;
