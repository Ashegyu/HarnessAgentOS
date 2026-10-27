import { createHash } from "node:crypto";
import type { QualityGateResult } from "@harness/core";

export type QualityFailureGate = Pick<QualityGateResult,
  "status" | "knownRisks" | "buildPassed" | "testsPassed" | "smokePassed">;

export interface FailedQualityChecker {
  checkerId: string;
  kinds: readonly string[];
  exitCode: number | null;
}

// Exact diagnostic text is intentional. Do not erase paths/numbers or infer
// assertion identity from unstructured logs. Recording IDs are not failures.
export const qualityFailureSignature = (
  gate: QualityFailureGate,
  failedCheckers: readonly FailedQualityChecker[] = [],
): string => {
  const checkers = [...new Set(failedCheckers.map(checker => JSON.stringify({
    checkerId: checker.checkerId,
    kinds: [...new Set(checker.kinds)].sort(),
    exitCode: checker.exitCode,
  })))].sort();
  const payload = JSON.stringify({
    status: gate.status,
    knownRisks: [...new Set(gate.knownRisks)].sort(),
    buildPassed: gate.buildPassed ?? null,
    testsPassed: gate.testsPassed ?? null,
    smokePassed: gate.smokePassed ?? null,
    failedCheckers: checkers,
  });
  return `quality-v2:${createHash("sha256").update(payload).digest("hex")}`;
};
