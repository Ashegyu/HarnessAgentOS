import { useEffect, useRef, useState } from "react";
import type { RegressionContractSummary } from "@harness/core";

const paths = (value: string): string[] => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

export function RegressionContractsPanel({ taskRunId, revision, onChanged }: {
  taskRunId: string; revision: unknown; onChanged: () => Promise<void>;
}): JSX.Element {
  const [contracts,setContracts] = useState<RegressionContractSummary[]>([]);
  const [title,setTitle] = useState("");
  const [referenceDir,setReferenceDir] = useState("");
  const [additionalReferences,setAdditionalReferences] = useState("");
  const [sources,setSources] = useState("");
  const [shared,setShared] = useState("");
  const [tests,setTests] = useState("");
  const [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; },[]);
  useEffect(() => {
    let active = true;
    void window.harness.quality.listRegressions({taskRunId}).then(rows => { if (active) setContracts(rows); })
      .catch(e => { if (active) setMessage(String(e)); });
    return () => { active = false; };
  },[taskRunId,revision]);

  const perform = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true); setMessage(null);
    try {
      await operation();
      const rows = await window.harness.quality.listRegressions({taskRunId});
      if (!active.current) return;
      setContracts(rows);
      setMessage(success); await onChanged();
    } catch (e) { if (active.current) setMessage(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current) setBusy(false); }
  };
  return <details className="regression-contracts">
    <summary>C# 회귀 검사 보호 ({contracts.length})</summary>
    <p className="muted">같은 검사를 등록한 정상 구현 모두와 현재 구현에서 실행합니다. 정상 구현을 전부 통과한 검사 파일과 공용 계약은 보호되며, 새 검사는 별도 파일로 추가하세요. 등록된 모든 검사의 최신 통과 결과가 완료 조건에 포함됩니다.</p>
    {contracts.map(c => <div key={c.id}>
      <p><strong>{c.title}</strong> · 정상 기준 {c.referenceCount??1}개 · {c.protected ? "보호 중" : "정상 기준 전체 통과 대기"}</p>
      <p className="muted">{c.verificationPaths.join(", ")}</p>
      <button type="button" disabled={busy} onClick={() => void perform(() => window.harness.quality.prepareRegression({taskRunId,contractId:c.id}),"승인 목록에서 검사 내용을 확인하고 개별 승인 후 실행하세요.")}>검사 실행 승인 요청</button>
    </div>)}
    <form onSubmit={event => {
      event.preventDefault();
      void perform(() => window.harness.quality.registerRegression({ taskRunId,title,referenceDir,
        additionalReferenceDirs:paths(additionalReferences),sourcePaths:paths(sources),sharedPaths:paths(shared),verificationPaths:paths(tests),manualConfirmation:confirmed }),"등록했습니다. 검사 실행 승인을 요청하세요.");
    }}>
      <fieldset disabled={busy}>
        <legend>검사 등록 (.NET 8 · 외부 패키지 없는 콘솔 검사)</legend>
        <label>검사 이름<input required value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>정상 기준 구현 폴더 (절대 경로)<input required value={referenceDir} onChange={e => setReferenceDir(e.target.value)} /></label>
        <label>추가 정상 구현 폴더 (선택, 최대 3개, 절대 경로를 한 줄에 하나)<textarea value={additionalReferences} onChange={e => setAdditionalReferences(e.target.value)} /></label>
        <label>구현 .cs 경로 (작업 폴더 기준, 한 줄에 하나)<textarea required value={sources} onChange={e => setSources(e.target.value)} /></label>
        <label>공용 계약 .cs 경로 (선택)<textarea value={shared} onChange={e => setShared(e.target.value)} /></label>
        <label>검사 .cs 경로 (Main 포함)<textarea required value={tests} onChange={e => setTests(e.target.value)} /></label>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />선택한 모든 구현을 같은 계약의 정상 기준으로 신뢰합니다. 기준 집합·공용 계약은 등록 시 저장되며, 검사 코드는 개별 실행 승인 후 호스트 권한으로 실행됩니다.</label>
        <button type="submit" disabled={!confirmed}>{busy ? "처리 중…" : "기준·검사 등록"}</button>
      </fieldset>
    </form>
    {message && <p role="status">{message}</p>}
  </details>;
}
