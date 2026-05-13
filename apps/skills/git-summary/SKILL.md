---
id: skill_git_summary
name: Git Summary
description: Summarize recent git activity — commits, changed files, and branch status — in a concise report.
risk: low
allowedActions:
  - shell_read
triggerTerms:
  - git summary
  - recent commits
  - what changed
  - git log
  - commit history
---

# Git Summary Skill

Produce a concise summary of the current git repository's recent activity.

## Steps

1. Run `git log --oneline -20` to list the last 20 commits.
2. Run `git status --short` to show the current working-tree state.
3. Run `git diff --stat HEAD~5..HEAD` to show file-level change statistics for the last 5 commits.
4. Synthesize the output into a short Markdown report with sections:
   - **Recent Commits** — bulleted list of commit hashes and messages
   - **Working-Tree Status** — staged, unstaged, untracked files
   - **Change Statistics** — top 5 most-edited files

## Constraints

- Read-only commands only (`git log`, `git status`, `git diff`). Never run `git push`, `git reset`, or any write command.
- If the directory is not a git repository, report the error clearly and stop.
