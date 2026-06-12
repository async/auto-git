# Rewrite Workflow

Use this reference after `git-intent-audit` has produced a history audit or the conversation already contains fresh equivalent evidence.

## Preflight

Verify:

```bash
git status --short --branch
git rev-parse --show-toplevel
git branch --show-current
git rev-parse --verify HEAD
git merge-base origin/main HEAD
```

Stop if the worktree is dirty unless the user explicitly asks for plan-only output. For actual local rewrite actions, require a clean worktree.

Do not rewrite `main`, `master`, `trunk`, `develop`, or a repo's configured default branch directly. Create a separate rewritten branch.

## Branch Names

Use predictable local names:

```text
backup/<branch>-before-history-rewrite-<date>
rewrite/<branch>-by-intent
```

If a branch exists, choose a non-conflicting suffix. Never delete an existing backup.

## Plan Mode

Default to plan mode. Emit:

- audit findings used
- old commits to keep, retitle, split, squash, or reorder
- proposed rewritten commits
- source commit hashes for each rewritten commit
- commit messages that match Auto Git's `commit-by-intent.md` style
- author and co-author decisions
- commands the human or a later approved run can execute
- verification commands

Plan mode must not mutate the repo.

## Script Mode

Script mode may write a script file, but the script should be reviewable and conservative:

- Start with `set -euo pipefail`.
- Resolve base and old head.
- Create a backup branch.
- Create a rewritten branch from base.
- Stop with clear instructions for manual hunk staging when a split cannot be represented safely.
- Never push.
- End with tree and range-diff verification commands.

Do not hide risky commands in functions. Keep the script readable.

## Local Branch Mode

Only run local branch mode when the user explicitly requested implementation, the audit has no unresolved `low` confidence blockers, and the worktree is clean.

Safe sequence:

```bash
old_head=$(git rev-parse HEAD)
base=$(git merge-base origin/main HEAD)
branch=$(git branch --show-current)
backup="backup/${branch}-before-history-rewrite-$(date +%Y%m%d%H%M%S)"
rewrite="rewrite/${branch}-by-intent"
git branch "$backup" "$old_head"
git switch -c "$rewrite" "$base"
```

Then apply each replay commit from the plan. Prefer exact source patches and hunk review over broad file checkouts when one file participates in multiple intent groups.

Stop on:

- conflicts
- ambiguous hunks
- generated files that do not map cleanly to source changes
- changed tree that does not match old head after replay
- author attribution uncertainty

## Verification Gates

After replay:

```bash
git diff --quiet "$old_head" HEAD
git range-diff "$base" "$old_head" HEAD
git log --format=fuller --decorate "$base"..HEAD
```

If the final tree differs, report the exact `git diff --stat "$old_head" HEAD` and do not suggest push.

## Remote Policy

Do not push automatically. If the user later asks to update the remote branch, require:

- backup branch name
- old head and rewritten head
- successful tree equality check
- reviewed range-diff
- `--force-with-lease`, never plain `--force`
