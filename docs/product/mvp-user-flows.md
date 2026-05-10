# MVP User Flow

## 목적

이 문서는 HarnessAgentOS MVP에서 사용자가 실제로 경험해야 하는 흐름을 고정한다. 구현자는 이 흐름을 기준으로 UI, IPC, 상태 모델, approval, artifact, quality gate를 연결한다.

## 공통 원칙

- 첫 화면은 landing page가 아니라 작업 가능한 workbench다.
- 사용자는 대화창에서 시작하지만, 개발 요청은 `TaskRun`으로 기록된다.
- 모든 side effect는 승인 전에는 실행되지 않는다.
- 중간 산출물은 UI에서 열 수 있어야 한다.
- 실패는 숨기지 않고 다음 선택지를 제공한다.
- 완료는 quality evidence와 사용자 final approval 뒤에만 가능하다.

## Flow 1: 첫 실행

1. 사용자가 앱을 실행한다.
2. 앱은 서버 없이 Electron 창으로 열린다.
3. 좌측에는 Thread 목록 또는 `작업 스레드 없음`이 표시된다.
4. 중앙에는 대화 입력 영역이 표시된다.
5. 우측에는 `승인 대기 없음`, `Artifact 없음`, `품질 결과 없음` 상태가 표시된다.
6. runtime status에는 local app data 경로와 앱 상태가 표시된다.

성공 기준:

- 브라우저 localhost 접속이 필요 없다.
- 사용자는 즉시 작업 요청을 입력할 수 있다.

## Flow 2: 작업 폴더 선택

1. 사용자가 targetDir 선택 버튼을 누른다.
2. 앱은 로컬 폴더 선택 UI를 연다.
3. 선택된 경로는 main process에서 normalize/validate된다.
4. 존재하지 않거나 접근 불가한 경로는 inline 오류로 표시된다.
5. 유효한 경로는 Thread 또는 TaskRun 기본 targetDir로 저장된다.

성공 기준:

- renderer가 파일 시스템을 직접 읽지 않는다.
- targetDir는 UI에 명확히 표시된다.
- 잘못된 경로는 TaskRun 생성 전에 막힌다.

## Flow 3: 대화 입력과 계획 생성

1. 사용자가 대화창에 개발 요청을 입력한다.
2. renderer는 `conversation.createTask` IPC를 호출한다.
3. main process는 Thread와 TaskRun을 생성한다.
4. Harness Core는 inspect/plan step을 만든다.
5. 계획 artifact를 저장한다.
6. `before_edit` checkpoint를 만든다.
7. 파일 수정 또는 shell 실행이 예상되면 pending approval을 만든다.
8. UI는 계획, 예상 action, approval panel을 표시한다.

성공 기준:

- 이 단계에서는 파일이 수정되지 않는다.
- 사용자는 실행 전에 계획과 예상 action을 볼 수 있다.

## Flow 4: 승인

1. 사용자가 pending action을 검토한다.
2. 사용자가 `승인`을 누른다.
3. approval status가 `approved`로 저장된다.
4. 실행 버튼 또는 자동 후속 실행은 approved approval id를 통해서만 가능하다.

성공 기준:

- 승인 없는 runner 실행은 실패한다.
- 승인 기록은 Checkpoint와 연결된다.

## Flow 5: 거절

1. 사용자가 `거절`을 누른다.
2. UI는 거절 이유 입력을 요구한다.
3. approval status가 `rejected`로 저장된다.
4. TaskRun은 `paused` 또는 `blocked`가 된다.
5. UI는 `수정 지시`, `다시 계획`, `취소` action을 표시한다.

성공 기준:

- 거절된 action은 자동 재시도되지 않는다.
- 거절 이유는 이후 plan context에 사용할 수 있다.

## Flow 6: 수정 지시

1. 사용자가 계획 또는 action에 대해 수정 지시를 입력한다.
2. renderer는 `conversation.redirectTask`를 호출한다.
3. Harness Core는 새 plan step을 만든다.
4. 새 plan artifact, checkpoint, approval이 생성된다.
5. 이전 approval은 history로 남는다.

성공 기준:

- 기존 이력을 덮어쓰지 않는다.
- 사용자는 방향 수정 후 다시 승인할 수 있다.

## Flow 7: 파일 수정과 artifact 확인

1. 사용자가 approved action 실행을 요청한다.
2. RunnerService가 approval, targetDir, policy를 확인한다.
3. FileRunner 또는 ShellRunner가 실행된다.
4. stdout/stderr, changed files, diff가 artifact로 저장된다.
5. UI는 Artifact panel에 diff/log를 표시한다.

성공 기준:

- targetDir 밖 파일 쓰기는 차단된다.
- diff를 사용자가 열어볼 수 있다.
- 실패한 command의 stderr가 숨겨지지 않는다.

## Flow 8: 테스트 실행

1. 사용자가 테스트 실행 action을 승인한다.
2. TestRunner가 명령을 실행한다.
3. exit code, stdout, stderr가 test_result/log artifact로 저장된다.
4. Timeline은 test step 성공/실패를 표시한다.

성공 기준:

- 테스트 미실행과 테스트 성공은 구분된다.
- 실패 로그가 quality gate에서 evidence로 사용된다.

## Flow 9: 품질 게이트 실패

1. 사용자가 quality evaluate를 실행하거나 runner 이후 자동 평가된다.
2. QualityEvaluator가 artifact와 step 결과를 읽는다.
3. evidence가 부족하거나 실패가 있으면 TaskRun status가 `quality_failed`가 된다.
4. UI는 missing evidence, known risks, 실패 artifact를 표시한다.
5. 사용자는 repair plan, retry tests, known risk 승인, 취소 중 선택한다.

성공 기준:

- quality gate 없이 done으로 갈 수 없다.
- 실패는 다음 action과 연결된다.

## Flow 10: Repair loop

1. 사용자가 repair plan 생성을 요청한다.
2. Harness Core는 새 plan artifact를 만든다.
3. `before_edit` checkpoint와 approval이 다시 생성된다.
4. 사용자는 승인/거절/수정 지시 흐름을 반복한다.
5. repair 실행 후 quality gate를 다시 수행한다.

성공 기준:

- repair는 새 TaskRun으로 튀지 않고 기존 TaskRun 이력에 남는다.
- 모든 repair side effect도 approval을 거친다.

## Flow 11: 최종 완료

1. QualityGateResult가 `passed`이거나 warning + known risk approval 상태다.
2. UI는 `ready_for_review` 상태를 표시한다.
3. 사용자가 final approval을 누른다.
4. TaskRun status가 `done`이 된다.
5. final summary artifact가 표시된다.

성공 기준:

- agent 자기 보고만으로 done이 되지 않는다.
- 최종 완료 이후에도 artifact와 quality evidence를 다시 볼 수 있다.

## Flow 12: 이어서 질문하기

1. 사용자가 같은 Thread에서 후속 질문을 입력한다.
2. 이전 TaskRun summary, targetDir, artifacts, quality state가 context로 사용된다.
3. 새 요청은 새 TaskRun이 되거나 기존 TaskRun repair/redirect로 연결된다.
4. UI는 관련 이전 작업 링크를 표시한다.

성공 기준:

- 사용자는 같은 폴더와 맥락에서 이어서 작업할 수 있다.
- 이전 실패와 artifact가 사라지지 않는다.
