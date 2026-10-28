import type {RegressionControlEvidence} from "./types/regression-contract.ts";

export const regressionControlArtifactHeader = (evidence:RegressionControlEvidence):string =>
  `<!-- harness-regression-control: ${JSON.stringify(evidence)} -->`;

/** Only the host-owned header position is accepted; matching text in stdout is data. */
export const readRegressionControlArtifact = (body:string):RegressionControlEvidence|null => {
  const match=/^# test_result\r?\n\r?\n<!-- harness-regression-control: ([^\r\n]+) -->\r?\n/.exec(body);
  if(!match?.[1]||match[1].length>1024)return null;
  try{
    const e=JSON.parse(match[1]) as RegressionControlEvidence;
    if(!e||e.schemaVersion!==1||typeof e.contractId!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(e.contractId)||
      !Number.isSafeInteger(e.referenceExitCode)||
      ![e.referenceFingerprint,e.candidateFingerprint,e.verificationFingerprint].every(s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s))||
      (e.candidateExitCode!==undefined&&(!Number.isSafeInteger(e.candidateExitCode)||e.referenceExitCode!==0)))return null;
    return e;
  }catch{return null;}
};
