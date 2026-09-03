# Workbench UI System

기준일: 2026-09-01

## 1. 디자인 방향

HarnessAgentOS의 화면은 일반 SaaS 대시보드가 아니라, 계획·승인·실행·검증을 오래 관찰하는 데스크톱 작업대다. 따라서 장식보다 정보 위계, 패널 경계, 장시간 사용 시 눈의 피로, 좁은 창에서의 예측 가능한 축소를 우선한다.

- 시각 언어: 차분한 control-room 계열의 slate surface와 단일 azure accent
- 밀도: 14px 본문, 10~11px 보조 정보, 36px 기본 조작 높이
- 표면: 앱 배경 → 기본 패널 → 상승 패널의 3단계
- 강조: 선택·포커스·주요 CTA에만 accent 사용
- 모션: 120~200ms 범위이며 `prefers-reduced-motion`에서는 사실상 제거

## 2. 레이아웃과 Offset 계약

레이아웃 수치는 `workbench-layout.ts`에서 생성한 CSS custom property가 단일 소스다. React가 저장 선호 폭을 전달하고 CSS Grid가 실제 화면 폭에 맞춰 배분한다.

| 영역 | 기본/선호 폭 | 최소 폭 | 최대 폭 |
|---|---:|---:|---:|
| Slim rail | 60px | 60px | 60px |
| Thread drawer | 272px | 180px | 400px |
| Main workspace | 가변 | 400px | 가용 폭 |
| Context drawer | 380px | 280px | 600px |
| Runtime status bar | 높이 32px | 32px | 32px |

Grid 순서는 `rail | thread | main | context`이며 상태바가 두 번째 행 전체를 차지한다. 두 드로어가 모두 열린 최소 창 960px에서도 Grid가 200px / 400px / 300px로 안전하게 배분되어 중앙 작업영역이 더는 216px까지 붕괴하지 않는다.

리사이저는 저장 폭을 더해 절대 좌표를 계산하지 않는다. 각 드로어의 실제 렌더링 경계에 자식으로 배치되므로 Grid가 폭을 압축해도 경계 중심과 일치한다. 1100px 이하에서는 선호 폭과 실제 폭이 다를 수 있으므로 리사이저를 숨기고 자동 배분만 사용한다.

## 3. 토큰

`global.css`는 dark/light 테마 모두에 다음 의미 토큰을 제공한다.

- Surface: `--bg-app`, `--bg-panel`, `--bg-panel-elev`, `--bg-input`
- Text: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-accent`, `--text-on-accent`
- Interaction: `--accent`, `--accent-strong`, `--accent-soft`, `--focus-ring`
- Status: pending/running/success/failed/blocked와 warning/passed/ready alias
- Shape: 4/6/10/14/20px radius 단계
- Depth: `--shadow-sm`, `--shadow-panel`, `--shadow-float`
- Motion: `--motion-fast`, `--motion-standard`

기존 CSS가 사용하면서 정의하지 않았던 accent, warning, passed, ready, surface, radius, shadow 토큰도 모두 명시해 테마별 선언 누락을 제거했다.

## 4. 핵심 Surface 규칙

### Slim rail

- 18px line icon을 공통 `WorkbenchIcon`으로 렌더링한다.
- 활성 상태는 accent soft fill과 경계로 표시한다.
- 새 작업 버튼만 강한 accent와 그림자를 사용한다.

### Thread drawer

- 빈 상태에서 기능 설명과 직접적인 새 작업 CTA를 제공한다.
- 선택된 스레드는 왼쪽 accent inset과 soft fill로 구분한다.
- 패널 헤더 높이는 52px로 중앙·우측 헤더와 맞춘다.

### Main workspace

- 헤더, transcript, composer는 동일한 chat canvas 폭을 공유한다.
- 740px 이하 container에서는 composer context를 2열로 재배치한다.
- 520px 이하 container에서는 경로와 보조 힌트를 정리해 요청 입력 공간을 보존한다.
- 환영 화면 제목은 container 기반 가변 크기와 `overflow-wrap`을 사용한다.

### Context drawer

- TaskRun 미선택 상태의 중복 placeholder를 하나의 설명형 empty state로 통합한다.
- 세로 탭 rail은 60px이며 공통 line icon을 사용한다.
- 위/아래 화살표로 탭을 이동할 수 있다.

### Runtime status bar

- 런타임 상태와 provider 상태를 양 끝에 고정한다.
- 경로는 남는 폭에서 ellipsis 처리하고 1100px 이하에서는 숨긴다.
- 상태바 자체가 가로 스크롤을 만들지 않는다.

## 5. 접근성 및 사용성

- 모든 기본 조작 요소에 2px `:focus-visible` ring을 제공한다.
- 좌우 리사이저는 `role="separator"`, 현재/최소/최대 값을 노출한다.
- 리사이저는 좌우 화살표로 16px씩 조절할 수 있다.
- 우측 세로 탭은 위/아래 화살표 순환 이동을 지원한다.
- CTA의 전경색은 dark/light별 `--text-on-accent`를 사용해 대비를 유지한다.
- 사용자가 reduced motion을 요청하면 animation, transition, smooth scroll을 제거한다.

## 6. 성능 경계

이 변경은 렌더 hot path에 상태 구독이나 resize listener를 추가하지 않는다. 폭 적응은 CSS Grid와 container query가 담당한다. 아이콘은 외부 패키지나 이미지 decode 없이 작은 inline SVG를 사용한다. 새 계산은 초기 localStorage 폭 정규화와 사용자가 리사이저 키를 누를 때만 수행된다.

## 7. 검증 기준

- 1280×800, dark: 네 영역과 상태바가 viewport 안에 있고 리사이저 중심이 실제 패널 경계와 일치
- 960×600, dark/light: Main workspace 최소 400px, 문구 잘림과 문서 가로 overflow 없음
- CSS token 사용에 미정의 custom property 없음
- renderer TypeScript check 및 production build 통과
- 기존 Electron smoke에서 실행·스레드 생성·설정 pipeline builder 흐름 유지
