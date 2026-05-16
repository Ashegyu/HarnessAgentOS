---
id: skill_test_runner
name: Test Runner
description: Run the project's test suite, capture failures, and produce a concise failure report with actionable fix hints.
risk: medium
allowedActions:
  - shell_read
  - shell_exec
triggerTerms:
  - test
  - tests
  - run tests
  - run the tests
  - execute tests
  - test suite
  - failing tests
  - test failures
  - 테스트
  - 테스트 실행
  - 테스트 실패
  - 실패한 테스트
  - 검증
---

# Test Runner Skill

Execute the project test suite and summarise results, highlighting failures with context.

## Steps

1. Detect the test command:
   - Check `package.json` for a `"test"` script → use `pnpm test` / `npm test`.
   - If a `vitest.config.*` exists → prefer `pnpm vitest run`.
   - If a `playwright.config.*` exists → use `pnpm playwright test`.
   - Fall back to `pnpm test` if unclear.
2. Run the detected command with output captured.
3. Parse the output for failure markers (`FAIL`, `Error`, `✗`, `not ok`).
4. For each failure, extract:
   - Test name / file path
   - Error message and stack trace (first 5 lines)
   - Suggested fix category (assertion error, type error, missing mock, etc.)
5. Emit a structured report.

## Output Format

```
## Test Results — <date>

**Total:** X passed, Y failed, Z skipped

### Failures

#### 1. <test name> — <file>:<line>
**Error:** <message>
**Hint:** <category and suggested fix>
```

## Constraints

- Never modify source or test files during the run.
- Timeout: abort if the test command runs longer than 5 minutes.
- Do not run tests that require network access unless the user explicitly confirms.
