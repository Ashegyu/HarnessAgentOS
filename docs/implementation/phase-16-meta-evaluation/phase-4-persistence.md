# Phase 4 — Persistence: migration v21 · EvalRunRepository · Markdown Reporter

> **선행 조건**: Phase 2 + Phase 3 (10 케이스 모두 동작)
> **다음 단계**: Phase 5 (CLI · CI)
> **복잡도**: Small-Medium · **추정**: 1-2일

## 0. 목표

평가 결과를 두 곳에 영속화: (1) **`eval_runs` 테이블** 빠른 조회용, (2) **`workspace/eval-runs/<runId>/report.md`** PR 리뷰용. 둘 다 필요 — DB는 trend 추적, md는 git diff로 회귀 가시화.

## 1. 출력물

```
packages/storage/src/
├── schema.ts                                      # SCHEMA_VERSION 20 → 21
├── migrations.ts                                  # v21 idempotent block
├── id.ts                                          # evalRun prefix 추가
├── services/local-state-service.ts                # evalRuns getter 추가
├── repositories/
│   ├── index.ts                                   # export 추가
│   ├── eval-run-repository.ts                     # 신규
│   └── eval-run-repository.test.mjs               # 신규
└── migrations.test.mjs                            # v21 idempotency 테스트 추가

packages/evals/src/
├── reporter.ts                                    # 신규
├── reporter.test.mjs                              # 신규
└── report-template.ts                             # markdown 템플릿
```

## 2. SCHEMA_VERSION (Risk L1)

### 2.1 충돌 확인

```bash
# 머지 직전 반드시:
git log master -- packages/storage/src/schema.ts | head -20
```

현재 `SCHEMA_VERSION = 20` (확인 필요 — 현재 코드 기준). 다른 브랜치가 v21을 선점하면 **v22로 재할당**, idempotent block은 그대로.

### 2.2 schema.ts 수정

```ts
// packages/storage/src/schema.ts
export const SCHEMA_VERSION = 21;  // 20 → 21
```

## 3. Migration v21 (`packages/storage/src/migrations.ts`)

기존 migration 블록 패턴 그대로:

```ts
// ... 이전 migrations ...

// v21 — eval_runs table for meta-evaluation system
if (currentVersion < 21 && !hasTable(db, "eval_runs")) {
  db.exec(`
    CREATE TABLE eval_runs (
      id              TEXT PRIMARY KEY,
      suite           TEXT NOT NULL CHECK(suite IN ('capability','regression','safety','all')),
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      status          TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial')),
      summary_json    TEXT NOT NULL,
      harness_sha     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_eval_runs_started_at ON eval_runs(started_at DESC);
    CREATE INDEX idx_eval_runs_suite_status ON eval_runs(suite, status);
  `);
}
```

**주의사항**:
- `summary_json` — JSON column 컨벤션 (`_json` suffix) 준수
- `CHECK` 제약으로 status/suite 값 강제
- timestamps는 ISO string (project 컨벤션)
- idempotent: 두 번 실행해도 NOOP
- 인덱스 2개 — `started_at DESC`로 최근 run 조회, `(suite, status)`로 suite별 실패 빈도 조회

## 4. ID prefix (`packages/storage/src/id.ts`)

```ts
const ID_PREFIXES = {
  // ... 기존 ...
  evalRun: "evrun_",
} as const;
```

`newId("evalRun")` 호출 시 `evrun_abc123def...` 형태.

## 5. EvalRunRepository (`packages/storage/src/repositories/eval-run-repository.ts`)

기존 `ApprovalRepository`, `QualityGateRepository` 패턴 그대로:

```ts
import type Database from "better-sqlite3";
import type { EvalRunSummary } from "@harness/evals";  // 또는 별도 타입 정의

export interface EvalRunRepository {
  create(input: CreateEvalRunInput): Promise<EvalRunRecord>;
  finish(id: string, input: FinishEvalRunInput): Promise<EvalRunRecord>;
  get(id: string): Promise<EvalRunRecord | null>;
  list(filters?: ListEvalRunFilters): Promise<ReadonlyArray<EvalRunRecord>>;
  delete(id: string): Promise<void>;
}

export interface EvalRunRecord {
  readonly id: string;
  readonly suite: "capability" | "regression" | "safety" | "all";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "passed" | "failed" | "partial";
  readonly summary: EvalRunSummary;
  readonly harnessSha: string | null;
  readonly createdAt: string;
}

export interface CreateEvalRunInput {
  readonly suite: EvalRunRecord["suite"];
  readonly harnessSha?: string;
}

export interface FinishEvalRunInput {
  readonly status: "passed" | "failed" | "partial";
  readonly summary: EvalRunSummary;
}

export interface ListEvalRunFilters {
  readonly suite?: EvalRunRecord["suite"];
  readonly status?: EvalRunRecord["status"];
  readonly limit?: number;
}

export class SqliteEvalRunRepository implements EvalRunRepository {
  constructor(private readonly db: Database.Database) {}

  async create(input: CreateEvalRunInput): Promise<EvalRunRecord> {
    const id = newId("evalRun");
    const startedAt = nowIso();
    const summary: EvalRunSummary = {
      runId: id, suite: input.suite,
      startedAt, finishedAt: null,
      cases: [], status: "running",
    };
    this.db.prepare(`
      INSERT INTO eval_runs (id, suite, started_at, status, summary_json, harness_sha)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, input.suite, startedAt, JSON.stringify(summary), input.harnessSha ?? null);
    return this.row(id);
  }

  async finish(id: string, input: FinishEvalRunInput): Promise<EvalRunRecord> {
    const finishedAt = nowIso();
    this.db.prepare(`
      UPDATE eval_runs
         SET finished_at = ?, status = ?, summary_json = ?
       WHERE id = ?
    `).run(finishedAt, input.status, JSON.stringify(input.summary), id);
    return this.row(id);
  }

  /* ... get/list/delete 구현은 기존 패턴 그대로 ... */

  private row(id: string): EvalRunRecord {
    const r = this.db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(id);
    return {
      id: r.id, suite: r.suite, startedAt: r.started_at,
      finishedAt: r.finished_at, status: r.status,
      summary: JSON.parse(r.summary_json),
      harnessSha: r.harness_sha, createdAt: r.created_at,
    };
  }
}
```

## 6. LocalStateService 노출 (`packages/storage/src/services/local-state-service.ts`)

```ts
export interface LocalStateService {
  // ... 기존 getters ...
  readonly evalRuns: EvalRunRepository;
}

export class SqliteLocalStateService implements LocalStateService {
  readonly evalRuns: EvalRunRepository;

  constructor(db: Database.Database) {
    // ... 기존 ...
    this.evalRuns = new SqliteEvalRunRepository(db);
  }
}
```

**중요**: IPC 노출 없음. `core/src/api.ts`의 `HarnessDesktopApi`에 evalRuns 추가하지 *않는다*. eval 시스템은 main process 안에서만 동작 (제약 C7).

## 7. Markdown Reporter (`packages/evals/src/reporter.ts`)

### 7.1 시그니처

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EvalRunSummary, EvalCaseResult } from "./types.ts";
import { renderReport } from "./report-template.ts";

export const writeMarkdownReport = async (
  summary: EvalRunSummary,
  outDir: string,
): Promise<string> => {
  const md = renderReport(summary);
  const filePath = path.join(outDir, "report.md");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(filePath, md, "utf8");
  return filePath;
};

export const writeAttemptArtifacts = async (
  caseResult: EvalCaseResult,
  outDir: string,
): Promise<void> => {
  for (const attempt of caseResult.attempts) {
    const attDir = path.join(outDir, caseResult.case.id, `attempt-${attempt.attemptIdx}`);
    await fs.mkdir(attDir, { recursive: true });
    await fs.writeFile(
      path.join(attDir, "result.json"),
      JSON.stringify(attempt, null, 2),
      "utf8",
    );
  }
};
```

### 7.2 템플릿 (`packages/evals/src/report-template.ts`)

```ts
export const renderReport = (s: EvalRunSummary): string => {
  const lines: string[] = [];
  lines.push(`# Eval Report — ${s.suite}`);
  lines.push("");
  lines.push(`- Run ID: \`${s.runId}\``);
  lines.push(`- Started: ${s.startedAt}`);
  lines.push(`- Finished: ${s.finishedAt ?? "(running)"}`);
  lines.push(`- Harness SHA: \`${s.harnessRevisionSha ?? "(unknown)"}\``);
  lines.push(`- Overall: **${s.status.toUpperCase()}**`);
  lines.push("");
  lines.push("## Summary by Suite");
  lines.push("");
  lines.push("| Suite | Cases | Pass@3 | Pass^3 | Total Tokens | Total Time |");
  lines.push("|-------|-------|--------|--------|--------------|------------|");
  for (const sec of groupBySuite(s.cases)) {
    lines.push(
      `| ${sec.suite} | ${sec.passed}/${sec.total} | ${pct(sec.passAt3Avg)} | ${pct(sec.passToThe3Avg)} | ${sec.totalTokens.toLocaleString()} | ${ms(sec.totalDurationMs)} |`,
    );
  }
  lines.push("");
  for (const c of s.cases) {
    lines.push(`### \`${c.case.id}\` — ${c.case.kind}`);
    lines.push("");
    lines.push(`> ${c.case.title}`);
    lines.push("");
    lines.push(`Pass@1: ${pct(c.passAt1)} · Pass@3: ${pct(c.passAt3)} · Pass^3: ${pct(c.passToThe3)} · Consistency: ${pct(c.consistency)}`);
    lines.push("");
    lines.push("| Attempt | Passed | Tokens | Time | Gate | FS Escape | Partial |");
    lines.push("|---------|--------|--------|------|------|-----------|---------|");
    for (const a of c.attempts) {
      lines.push(
        `| ${a.attemptIdx} | ${a.passed ? "✅" : "❌"} | ${a.tokens.toLocaleString()} | ${ms(a.durationMs)} | ${a.gateStatus ?? "—"} | ${a.fsEscapeDetected ? "⚠️" : "—"} | ${a.partialPassAsFail ? "⚠️" : "—"} |`,
      );
    }
    if (c.attempts.some((a) => a.graderReason)) {
      lines.push("");
      lines.push("**Failure reasons**:");
      for (const a of c.attempts.filter((x) => x.graderReason)) {
        lines.push(`- attempt-${a.attemptIdx}: ${a.graderReason}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
};

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const ms = (n: number) => n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
```

### 7.3 결과 예시

```markdown
# Eval Report — all

- Run ID: `evrun_abc123def456`
- Started: 2026-05-17T14:00:00.000Z
- Finished: 2026-05-17T14:03:42.000Z
- Harness SHA: `a96189f`
- Overall: **PASSED**

## Summary by Suite

| Suite | Cases | Pass@3 | Pass^3 | Total Tokens | Total Time |
|-------|-------|--------|--------|--------------|------------|
| capability | 3/3 | 100% | 100% | 24,000 | 12.3s |
| regression | 3/3 | 100% | 100% | 18,500 | 8.9s |
| safety | 4/4 | 100% | 100% | 9,200 | 6.1s |

### `file-write-readme` — capability

> 에이전트가 README.md를 생성하는 단순 사례

Pass@1: 100% · Pass@3: 100% · Pass^3: 100% · Consistency: 100%

| Attempt | Passed | Tokens | Time | Gate | FS Escape | Partial |
|---------|--------|--------|------|------|-----------|---------|
| 0 | ✅ | 800 | 1.2s | passed | — | — |
| 1 | ✅ | 820 | 1.1s | passed | — | — |
| 2 | ✅ | 790 | 1.3s | passed | — | — |
```

## 8. 단위 테스트

### 8.1 `migrations.test.mjs` 추가

```js
test("v21 migration creates eval_runs with check constraints + indexes", () => {
  const db = openInMemory();
  applyMigrations(db);
  const cols = db.prepare(`PRAGMA table_info(eval_runs)`).all();
  assert.ok(cols.find((c) => c.name === "summary_json"));
  // CHECK 제약 검증 — 잘못된 status 거부
  assert.throws(() => {
    db.prepare(`INSERT INTO eval_runs (id, suite, started_at, status, summary_json) VALUES (?, ?, ?, ?, ?)`)
      .run("x", "capability", nowIso(), "INVALID", "{}");
  }, /CHECK constraint failed/);
});

test("v21 migration is idempotent", () => {
  const db = openInMemory();
  applyMigrations(db);
  applyMigrations(db);  // 두 번째 호출 NOOP
  const ver = readSchemaVersion(db);
  assert.equal(ver, 21);
});
```

### 8.2 `eval-run-repository.test.mjs`

```js
test("EvalRunRepository.create marks status=running and returns full record", async () => {
  const repo = new SqliteEvalRunRepository(db);
  const r = await repo.create({ suite: "capability" });
  assert.equal(r.status, "running");
  assert.match(r.id, /^evrun_/);
  assert.equal(r.summary.runId, r.id);
});

test("EvalRunRepository.finish updates status and summary_json", async () => {
  const repo = new SqliteEvalRunRepository(db);
  const r = await repo.create({ suite: "capability" });
  const finished = await repo.finish(r.id, {
    status: "passed",
    summary: { /* ... full summary ... */ },
  });
  assert.equal(finished.status, "passed");
  assert.ok(finished.finishedAt);
});

test("EvalRunRepository.list orders by started_at DESC", async () => {
  /* ... */
});
```

### 8.3 `reporter.test.mjs`

```js
test("renderReport produces valid markdown with all sections", () => {
  const summary = makeFixtureSummary();
  const md = renderReport(summary);
  assert.match(md, /^# Eval Report — /m);
  assert.match(md, /## Summary by Suite/);
  assert.match(md, /Pass@3: \d+%/);
});

test("writeMarkdownReport creates file at <outDir>/report.md", async () => {
  const tmp = await mkdtemp();
  const file = await writeMarkdownReport(makeFixtureSummary(), tmp);
  assert.equal(file, path.join(tmp, "report.md"));
  assert.ok((await fs.stat(file)).isFile());
});
```

## 9. DoD

- [ ] `SCHEMA_VERSION = 21`, `eval_runs` 테이블 생성됨
- [ ] migration이 v20 DB / fresh DB 양쪽에 idempotent
- [ ] `EvalRunRepository.{create, finish, get, list, delete}` 동작
- [ ] `core` 패키지에 storage import 추가 0건 (제약 준수). `EvalRunSummary` 타입은 `@harness/evals`에 둠
- [ ] `LocalStateService.evalRuns` 노출, IPC 노출 0건
- [ ] `writeMarkdownReport(summary, outDir)` 호출 시 `<outDir>/report.md` 생성
- [ ] reporter 출력이 git diff로 PR에서 의미있게 비교 가능 (table 형식 일관)
- [ ] 마이그레이션 + repo + reporter 테스트 모두 통과
- [ ] `npm run check` + `npm run test` 통과

## 10. 이 phase에서 *하지 않을* 일

- ❌ IPC 노출 (제약 C7, v2 viewer에서 도입)
- ❌ Renderer UI (v2)
- ❌ CLI entry (Phase 5)
- ❌ 임계 기반 exit code (Phase 5)
- ❌ Cost trend 시각화 (v2)

## 11. 위험 + 완화

| 등급 | 위험 | 완화 |
|-----|------|------|
| LOW | `SCHEMA_VERSION = 21` 충돌 | 머지 직전 `git log master -- schema.ts` 재확인. v22로 재할당 가능 |
| LOW | `EvalRunSummary` 타입을 어디에 둘지 (core vs evals) | `@harness/evals`에 둔다. storage repository는 `EvalRunRecord`만 알면 됨. core에 storage import 금지 제약 보호 |
| LOW | summary_json이 커서 row가 비대해짐 | attempts 상세는 `workspace/eval-runs/<id>/<caseId>/attempt-N/result.json` 별도 파일. summary_json은 요약만 |
| LOW | CHECK 제약이 너무 빡빡해서 v2 확장 시 거부 | suite enum에 "all" 포함, status enum에 "partial" 포함 (이미). 새 값 추가는 v22 migration으로 |
