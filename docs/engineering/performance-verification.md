# Workbench 부하 검증

2026-10-27 Windows, Electron 42.11.16 / Node 24.19.0 / ABI 146 기준이다.
실제 사용자 DB나 모델을 사용하지 않는다. 아래 수치는 합성 부하의 측정 결과이며 SLA가 아니다.

## 재현

현재 native SQLite가 Electron ABI용인 경우 PowerShell에서 다음과 같이 실행한다.
일반 Node용으로 native module을 교체하지 않는다.

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:HARNESS_BENCH_VARIANT = 'baseline'
& .\node_modules\electron\dist\electron.exe --expose-gc --import tsx scripts/bench/workbench-load.mjs
$env:HARNESS_BENCH_VARIANT = 'current'
& .\node_modules\electron\dist\electron.exe --expose-gc --import tsx scripts/bench/workbench-load.mjs
```

각 실행은 private temp WAL DB를 만들고 종료 시 제거한다. 기본 크기는 300 threads,
3,000 tasks, 12,000 answer artifacts, 100,000 gates다. `HARNESS_BENCH_THREADS`,
`HARNESS_BENCH_GATES`, `HARNESS_BENCH_RUNS`로 상한 내에서 조절한다. baseline 비교기는
그 private DB에서 새 인덱스 두 개를 제거하고 기존 getThreadDetail fan-out 경로를 호출한다.
checkout과 실제 DB를 되돌리지 않는다. 첫 수정 전 실행의 원본도 별도로 보존했다.

5회 warm-up 후 100회 지연 P50/P95/P99와 처리량을 기록한다. 10개 동시 요청은 20개
배치 전체를 별도로 측정한다. 개별 P95를 더해 배치 P95로 표시하지 않는다.
최종 결과의 JSON 직렬화 비용은 포함하지만 Electron IPC 전송·renderer layout 시간은
포함하지 않는다. 기존 palette가 IPC로 옮기던 중간 답변 payload 직렬화 비용도 이
저장소 비교기에는 포함하지 않는다. 메모리는 관측된 peak heap/RSS 증가량이며 allocation
rate나 GC 정지시간이 아니다. 다른 benchmark/build/E2E와 동시에 실행하지 않는다.

## 유지할 경계

- 최근 10개 명령은 bounded metadata query 한 번으로 얻는다. 답변/전체 history를 읽지 않는다.
- 품질 최신 판정은 timestamp가 아닌 기존 rowid 삽입 순서를 유지한다.
- 인덱스의 task 범위 탐색과 LIMIT 적용은 결정적 query-plan 회귀로 검사한다.
- notification push는 같은 task의 active 1 + trailing 1로 합친다. 서로 다른 task의 알림
  pull은 최대 4개다. component 해제 후 queued work/늦은 publish는 폐기한다.
- 알림 gate는 상세에 포함된 canonical 삽입 순서의 마지막 결과다. 추가 quality IPC는 없다.
- 기존 선택 세대, 수동 승인, Pause/Cancel, 종료 drain과 pipeline 병렬도 정책은 유지한다.

`.ecc/benchmarks/workbench-load-2026-10-27.json`은 전후 및 반복 측정 요약이다.
E2E `apps/desktop/e2e/workbench-load.test.mjs`는 실제 main handler를 관측해 최근 명령의
40→1 IPC, 동일 task push 100개, 서로 다른 task push 15개의 조회 수/최대 동시성을 확인한다.
테스트는 실제 userData 경로가 생성한 private temp 경로와 같은지 쓰기 전에 검증한다.
30ms IPC 응답 지연은 중복 요청의 겹침을 결정적으로 드러내는 fixture이며 성능 수치가 아니다.

schema 43의 두 인덱스는 기존 행을 변환하지 않는다. 10만 gate fixture에서 신규 인덱스
적용 시간과 DB 증가량도 기록한다. 대규모 운영 DB의 migration 시간은 별도 확인이 필요하다.

이번 범위 밖의 다음 후보는 단일 대화에 쌓이는 큰 answer history, 다중 task worker의
전역 process 예산, 큰 workspace hash I/O, GPU/frame latency와 장시간 soak다. 기존
전역 동시성 정책이나 안전한 품질 fingerprint를 측정 없이 변경하지 않는다.
