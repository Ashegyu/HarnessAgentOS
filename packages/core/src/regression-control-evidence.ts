import type {RegressionControlEvidence} from "./types/regression-contract.ts";

export const regressionControlArtifactHeader = (evidence:RegressionControlEvidence):string =>
  `<!-- harness-regression-control: ${JSON.stringify(evidence)} -->`;

/** Only the host-owned header position is accepted; matching text in stdout is data. */
export const readRegressionControlArtifact = (body:string):RegressionControlEvidence|null => {
  const match=/^# test_result\r?\n\r?\n<!-- harness-regression-control: ([^\r\n]+) -->\r?\n/.exec(body);
  if(!match?.[1]||match[1].length>4096)return null;
  try{
    const e=JSON.parse(match[1]) as RegressionControlEvidence;
    if(!e||e.schemaVersion!==1||typeof e.contractId!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(e.contractId)||
      !Number.isSafeInteger(e.referenceExitCode)||
      ![e.referenceFingerprint,e.candidateFingerprint,e.verificationFingerprint].every(s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s))||
      (e.candidateExitCode!==undefined&&(!Number.isSafeInteger(e.candidateExitCode)||e.referenceExitCode!==0)))return null;
    const refs=e.references;
    if(refs!==undefined&&(!refs||!Number.isSafeInteger(refs.total)||refs.total<2||refs.total>4||!Array.isArray(refs.exits)||!refs.exits.length||refs.exits.length>refs.total||
      !refs.exits.every(Number.isSafeInteger)||refs.exits.slice(0,-1).some(n=>n!==0)||refs.exits.at(-1)!==e.referenceExitCode||
      (e.referenceExitCode===0&&refs.exits.length!==refs.total)))return null;
    const c=e.compilationFailure;
    if(c!==undefined){
      if(!c||!Number.isSafeInteger(c.exitCode)||c.exitCode===0||
        (c.phase==='reference'?(e.referenceExitCode!==c.exitCode||e.candidateExitCode!==undefined):c.phase==='candidate'?(e.referenceExitCode!==0||e.candidateExitCode!==c.exitCode):true)||
        !Array.isArray(c.diagnostics)||c.diagnostics.length>4||!c.diagnostics.every(d=>d&&typeof d.code==='string'&&/^(CS|MSB|NETSDK|NU)\d{3,5}$/.test(d.code)&&
          typeof d.message==='string'&&d.message.length>0&&d.message.length<=240&&
          (d.path===undefined||(typeof d.path==='string'&&d.path.length<=240&&!/^[\\/]|[:\x00-\x1f]/.test(d.path)&&!d.path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')&&/\.cs$/i.test(d.path)))&&
          [d.line,d.column].every(n=>n===undefined||(Number.isSafeInteger(n)&&n>0&&n<=10000000))))return null;
    }
    return e;
  }catch{return null;}
};
