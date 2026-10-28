// Post-hoc interpretation; preserves all frozen scores and makes a discovered input confound explicit.
import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(process.argv[2]),read=name=>JSON.parse(readFileSync(join(root,name),'utf8'));
const result=read('attempts.json'),summary=read('summary.json'),audit=read('audit.json');
const cases=[];
for(const id of ['lease-pool','ledger-writer']){
 const rows=result.attempts.filter(r=>r.id===id),mean=arm=>rows.filter(r=>r.arm===arm).reduce((s,r)=>s+r.score,0)/2;
 const compileFailures=rows.filter(r=>!r.hidden.compiled).map(r=>({arm:r.arm,repeat:r.repeat,
  missingOptionalArgument:/error CS7036/.test(readFileSync(join(root,'attempts',id,r.repeat+'-'+r.arm,'hidden','execution.log'),'utf8'))}));
 cases.push({id,before:mean('before'),after:mean('after'),delta:mean('after')-mean('before'),compileFailures,
  inputMaskObserved:rows.every(r=>read(join('attempts',id,r.repeat+'-'+r.arm,'request.json')).prompt.includes('cancellation[REDACTED]')),
  interpretation:id==='ledger-writer'?'Exclude from learning-effect interpretation: input redaction removed cancellation-parameter defaults and 3 outputs failed optional-call compilation.':'No observed optional-call compilation damage. Implementations all passed hidden groups; the observed difference is in verifier reliability. Only two repetitions per arm.'});
}
const review={rawSummary:summary,auditValid:audit.valid,cases,
 conclusion:'Observed verifier-score improvement on LeasePool: 60 to 80 (+20), with individual after scores 100 and 60. The raw all-case increase 30 to 75 (+45) is confounded by an existing input redaction defect. This small result does not establish a general or statistically reliable learning benefit.',
 noExtraModelCalls:true,noScoresChanged:true,limitation:'C# cancellationToken default fragments were redacted equally in both arms. LedgerWriter has observable API-signature damage. Equality of input conditions does not prove the task specification survived preprocessing.'};
writeFileSync(join(root,'review.json'),JSON.stringify(review,null,2));
if(!existsSync(join(root,'report-raw.html')))copyFileSync(join(root,'report.html'),join(root,'report-raw.html'));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
writeFileSync(join(root,'report.html'),'<!doctype html><html lang="ko"><meta charset="utf-8"><title>Learn 독립 평가 · 검토 결과</title><style>body{font:16px system-ui;max-width:1050px;margin:36px auto;padding:24px;line-height:1.7;background:#101822;color:#e8edf3}table{border-collapse:collapse;width:100%}th,td{padding:12px;border-bottom:1px solid #456;text-align:left}.warning{border-left:5px solid #e0ad56;background:#30271b;padding:16px}a{color:#9cf}code{overflow-wrap:anywhere}</style><h1>Learn·메모리 독립 평가</h1><p>합성 학습 사례 3개와 별도 문제 2개. 같은 앱·gpt-5.6-sol·medium 설정으로 조건당 2회, 총 8회 호출했습니다. 채점 기준을 고정하고 평가 출력을 학습에 사용하지 않았습니다.</p><div class="warning"><strong>전체 원점수 상승을 그대로 학습 효과라고 해석할 수 없습니다.</strong><br>기존 민감정보 필터가 C# 매개변수 기본값을 가리는 문제가 발견됐습니다. 두 조건에 똑같이 적용됐지만, LedgerWriter의 API 컴파일 실패 3건과 겹칩니다. 그 문제는 효과 판정에서 제외하며, 원점수·로그는 변경하지 않았습니다.</div><table><tr><th>평가 문제</th><th>학습 전 평균</th><th>학습 후 평균</th><th>차이</th><th>해석</th></tr>'+cases.map(c=>'<tr><td>'+esc(c.id)+'</td><td>'+c.before+'</td><td>'+c.after+'</td><td>+'+c.delta+'</td><td>'+esc(c.id==='lease-pool'?'회귀 검사 품질에서 개선 관측. 구현 점수는 동일. 반복 수가 적음.':'입력 필터 영향으로 효과 판정 제외')+'</td></tr>').join('')+'</table><p>전체 원점수: 30 → 75 (+45). 참고 기록이며 학습 효과의 확정치가 아닙니다.</p><p>LeasePool: 전 60/60, 후 100/60. 학습 후에도 정상 기준 구현을 잘못 실패시키는 검사가 남아 있습니다. 계속 사용하면 점수가 항상 오른다는 결론은 낼 수 없습니다.</p><p>입력 필터의 CancellationToken 기본값 손상은 평가 종료 후 별도 회귀 검사로 수정했습니다. 수정된 필터로 모델을 재호출하지 않았으므로 위 점수는 당시 실험 기록입니다. 최종 호환성 수정 이후 8개 요청에 선택되는 교훈 내용이 모두 같은지도 모델 호출 없이 재검증했습니다. 기존 일반 지침 보존·경험 중복 방지·불필요한 workspace 재검사 제거는 비교 결과를 보고 학습 내용을 보정한 변경이 아닙니다.</p><p><a href="report-raw.html">고정 채점 원본</a> · <a href="review.json">검토 데이터</a> · <a href="audit.json">조건 감사 26개</a> · <a href="context-replay.json">교훈 재전달 동등성</a> · <a href="protocol.json">사전 고정 프로토콜</a></p><p>방법 참고: <a href="https://developers.openai.com/api/docs/guides/evaluation-best-practices">OpenAI 평가 원칙</a>. 소규모·특정 도메인 결과이며 모델 가중치를 훈련한 실험은 아닙니다.</p></html>');
console.log(JSON.stringify({raw:summary.averages,interpretableLeaseOnly:{before:cases[0].before,after:cases[0].after},excluded:'ledger-writer',unchangedScores:true}));

