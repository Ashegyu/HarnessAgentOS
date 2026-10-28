import type {RegressionControlEvidence} from '@harness/core';

/** Called only on output from the host-owned build process, before any application is executed. */
export function regressionCompilerDiagnostics(output:string,sources:readonly {path:string}[]):NonNullable<RegressionControlEvidence['compilationFailure']>['diagnostics']{
  const result:NonNullable<RegressionControlEvidence['compilationFailure']>['diagnostics']=[],seen=new Set<string>();
  const pattern=/(?:^|\n)[^\r\n]*Source(\d+)\.cs\((\d+),(\d+)\):\s*error\s+((?:CS|MSB|NETSDK|NU)\d{3,5}):\s*([^\r\n]+)/g;
  for(const m of output.matchAll(pattern)){
    const source=sources[Number(m[1])],line=Number(m[2]),column=Number(m[3]);
    if(!source||line<1||line>10000000||column<1||column>10000000)continue;
    const diagnostic={code:m[4]!,message:m[5]!.replace(/ \[[^\]\r\n]+\.csproj\]$/,'').slice(0,240),line,column,...(source.path.length<=240?{path:source.path}:{})};
    const id=JSON.stringify(diagnostic);if(seen.has(id))continue;seen.add(id);result.push(diagnostic);if(result.length===4)break;
  }
  return result;
}
