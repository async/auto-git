# Audit Existing History

Use this reference for existing commits that may need splitting, retitling, or replaying by change intent. Keep the audit read-only.

## Range Selection

Prefer a branch-relative range:

```bash
git merge-base origin/main HEAD
git log --oneline --decorate <base>..HEAD
```

If `origin/main` does not exist, identify the default branch from `git remote show origin` or ask the user for the base. Do not assume the whole repository history should be rewritten.

## Commit Evidence

Use inspection commands:

```bash
git show --stat --summary <sha>
git show --name-status --find-renames <sha>
git show --numstat --format=fuller <sha>
git show --format=fuller --no-patch <sha>
git diff-tree --no-commit-id --name-status -r <sha>
```

Read patches only as needed with `git show --format=fuller -- <path>` or `git show <sha> -- <path>`.

## Finding Heuristics

Flag a commit as `oversized-change` when it exceeds either:

- More than 500 changed lines.
- More than 15 changed files.

Flag `mixed-intent` when one commit includes unrelated combinations such as:

- runtime behavior plus unrelated docs or cleanup
- dependency updates plus unrelated feature work
- mechanical rename plus behavior edits
- migration plus unrelated UI/API changes
- generated/snapshot churn not clearly tied to one source change
- multiple package, route, command, adapter, or workflow changes with separate reasons

Flag `message-diff-mismatch` when:

- the subject says docs/test/style/chore but runtime behavior changed
- the subject says feature but the diff is a fix, security hardening, or migration
- the subject names the wrong package, route, component, or command
- the body claims scope or behavior not supported by the diff
- the message is vague enough that future readers cannot infer the actual intent

## Message Correction Rules

Suggest corrected messages from diff evidence using Auto Git's `commit-by-intent.md` style. Do not create a separate style here. Match Auto Git's type list, scope guidance, concrete-action wording, and `chore` last-resort rule.

Fallback examples when Auto Git is unavailable:

```text
fix(auth): reject expired refresh tokens
feat(admin): add provider diagnostics
security(api): validate webhook signatures
docs(cli): explain local preview setup
deps(web): update vite
migrate(db): add provider status table
```

Do not silently rewrite intent. Show the old subject, proposed subject, and evidence.

## History Report Shape

```markdown
### History Findings
- `<sha>` `<subject>`
  - findings: oversized-change | mixed-intent | message-diff-mismatch | needs-human-review
  - evidence: <paths, stats, patch observations>
  - suggested split:
    - `type(scope): message` from <paths/hunks>
    - `type(scope): message` from <paths/hunks>
  - style source: Auto Git commit-by-intent
  - attribution: <authors and co-authors observed>
  - confidence: high | medium | low

### Rewrite Candidates
- `<sha>` -> split into <n> intent commits
- `<sha>` -> retitle to `type(scope): message`
```
