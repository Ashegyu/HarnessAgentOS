/** A user-supplied positive control. References are never inferred by a model. */
export interface RegisterRegressionContractInput {
  taskRunId: string;
  title: string;
  referenceDir: string;
  /** Additional user-trusted implementations, frozen together at registration (up to three). */
  additionalReferenceDirs?: string[];
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
  referenceCount?: number;
}
export const regressionCheckerId = (id: string): string => `regression:${id}`;

/** Written by the host outside process stdout; absent for legacy/generic shell runs. */
export interface RegressionControlEvidence {
  schemaVersion: 1;
  contractId: string;
  referenceExitCode: number;
  candidateExitCode?: number;
  referenceFingerprint: string;
  candidateFingerprint: string;
  verificationFingerprint: string;
  /** Ordered host exits; all controls must finish successfully before candidate execution or adoption. */
  references?: {total:number;exits:number[]};
  /** Only a separate host dotnet build may populate this; program stdout cannot. */
  compilationFailure?: {
    phase:'reference'|'candidate';
    exitCode:number;
    diagnostics:Array<{code:string;message:string;path?:string;line?:number;column?:number}>;
  };
}
