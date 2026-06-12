# Audit Dirty Worktree

Use this reference for large unstaged changes, mixed staged/unstaged changes, or unclear commit boundaries. Keep the audit read-only.

## Inventory

Run only inspection commands:

```bash
git status --short --branch
git diff --stat
git diff --name-status
git diff --find-renames --name-status
git diff --cached --stat
git diff --cached --name-status
git ls-files --others --exclude-standard
```

Read targeted diffs with `git diff -- <path>` or `git diff --cached -- <path>`. When one file looks mixed, inspect enough context to propose hunks, but do not stage them.

## Audit Triggers

Flag a dirty worktree for deeper review when any of these are true:

- More than 15 changed files.
- More than 500 changed lines.
- Staged and unstaged changes both exist.
- One file appears to contain multiple unrelated intents.
- Changes span unrelated top-level packages, routes, commands, adapters, docs, or config systems.
- Lockfiles, snapshots, generated files, large assets, deletions, renames, migrations, or security-sensitive files changed.
- The only likely message would be vague, such as `update`, `misc`, `cleanup`, or `changes`.

## Grouping Rules

- Group changes by why they exist, not by file type alone.
- Use Auto Git's `commit-by-intent.md` as the canonical style for proposed commit messages.
- Keep regression tests with the fix they prove.
- Keep behavior docs with the behavior when separating them would make either commit misleading.
- Keep lockfile changes with the dependency or package change that caused them.
- Split formatting-only churn from behavior changes unless formatting is required by the touched files.
- Split mechanical renames/moves from behavior edits when that improves review.
- Leave unrelated user notes, experiments, local config, logs, caches, env files, and `.goalbuddy-board/` bundles out.

## Confidence

Use confidence to decide the next action:

| Confidence | Meaning | Next action |
| --- | --- | --- |
| `high` | Clear files/hunks, clear intent, low special-file risk | Auto Git may commit after showing the plan if mode allows |
| `medium` | Likely grouping, but review would reduce risk | Show the plan; ask only if action is risky |
| `low` | Mixed hunks, unclear ownership, deletion/sensitive file risk, or special files do not map cleanly | Ask before any commit action |

## Worktree Report Shape

```markdown
### Proposed Intent Groups
- `type(scope): message`
  - files/hunks: <paths or hunk descriptions>
  - why: <evidence from diff/code/tests/docs>
  - confidence: high | medium | low
  - verification: <small check>
  - style source: Auto Git commit-by-intent

### Leave Untouched
- `<path>`: <reason>

### Boundary Questions
- <one decision that blocks a safe split>
```
