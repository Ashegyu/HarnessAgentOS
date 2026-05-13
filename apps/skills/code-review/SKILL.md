---
id: skill_code_review
name: Code Review
description: Review staged or recently changed code for quality, correctness, and potential bugs. Produces an actionable review report.
risk: low
allowedActions:
  - shell_read
  - file_read
triggerTerms:
  - code review
  - review my code
  - review changes
  - review diff
  - check my code
---

# Code Review Skill

Perform a structured code review on recently modified files and produce a prioritised issue list.

## Steps

1. Identify files to review:
   - If the user specified files, use those.
   - Otherwise run `git diff --name-only HEAD` to find recently changed files.
2. Read each file's content and the corresponding diff (`git diff HEAD -- <file>`).
3. For each file, evaluate:
   - **Correctness** — logic errors, off-by-one, null/undefined handling
   - **Security** — injection risks, exposed secrets, unsafe operations
   - **Readability** — naming, function length (<50 lines), nesting depth (<4)
   - **Test coverage** — are new code paths covered by tests?
4. Emit findings grouped by severity:
   - `CRITICAL` — must fix (data loss, security)
   - `HIGH` — should fix before merge
   - `MEDIUM` — maintainability concern
   - `LOW` — style suggestion

## Output Format

```
## Code Review — <branch or date>

### CRITICAL
- [file:line] <description>

### HIGH
- [file:line] <description>

### Summary
X critical, Y high, Z medium, W low issues found.
```

## Constraints

- Read-only — never modify files during review.
- Skip generated files (`*.min.js`, `dist/**`, `*.lock`).
