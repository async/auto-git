# Commit by Intent

Use this reference when a repo has many unstaged changes, mixed staged/unstaged state, or unclear commit boundaries. The goal is history that explains why the work happened. Intent is broader than features: it includes fixes, security, performance, refactors, tests, docs, dependencies, build, CI, migrations, releases, reverts, and maintenance.

Auto Git owns staging and committing. For heavier read-only analysis, use `git-intent-audit` when installed. For existing commit history cleanup or replay, use `git-history-rewrite` instead of rewriting history from Auto Git.

## Classification Workflow

1. Build the change inventory:
   - `scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state` when available
   - `git status --short`
   - `git diff --name-status`
   - `git diff --stat`
   - `git diff --find-renames --name-status`
   - `git ls-files --others --exclude-standard`

2. Read enough code to classify intent:
   - reuse a cached high-confidence intent plan only when the snapshot's `HEAD`, upstream, staged fingerprint, and dirty fingerprint match exactly
   - targeted `git diff -- <path>`
   - nearby tests and fixtures
   - package manifests and lockfile deltas
   - docs changed near the code
   - generated files or build outputs
   - route, command, component, or API names

3. Group by why the change exists:
   - user-facing feature
   - bug fix
   - security hardening
   - performance improvement
   - refactor without behavior change
   - test coverage
   - docs tied to behavior
   - style or formatting-only change
   - dependency-only update
   - build/package system change
   - CI workflow change
   - database/schema/data migration
   - release metadata
   - revert
   - mechanical maintenance
   - generated output tied to a source change

4. Identify what not to stage:
   - editor files, logs, caches, local env files
   - generated board bundles such as `.goalbuddy-board/`
   - unrelated user notes or experiments
   - accidental debug output
   - files with credential-looking content

Cached plans are advisory only. They can speed up repeated inspection after an
interrupted run, but Auto Git still owns the current staged diff inspection
before every commit.

## Optional Companion Routing

Use `git-intent-audit` before committing when any of these are true:

- more than 15 changed files
- more than 500 changed lines
- mixed staged and unstaged changes
- mixed hunks inside one file
- lockfiles, generated files, snapshots, deletions, renames, migrations, or security-sensitive areas
- unclear intent, ownership, or commit boundary
- user asks to split the work, figure out intent, audit commit quality, or fix commit messages

Use `git-history-rewrite` when the target is existing commits rather than the current dirty worktree:

- split large historical commits
- correct misleading commit messages
- replay a branch into better intent commits
- preserve authors while rebuilding history
- produce a local rewritten branch without force-pushing

## Splitting Rules

- Keep tests with the feature or fix they prove.
- Keep docs with the behavior they document when the docs would be misleading alone.
- Keep lockfile changes with the dependency/package change that caused them.
- Split mechanical renames from behavior edits when doing so makes review easier.
- Split formatting-only churn from behavior changes unless the formatter is required by the touched files.
- Split generated files only if the repo convention expects generated output in commits.
- Do not use `chore` when `deps`, `build`, `ci`, `release`, `migrate`, `security`, `style`, `test`, `docs`, or `refactor` fits.
- If one file contains multiple unrelated changes, use hunk-level staging.

## Intent Types

Use the most specific type that honestly describes the commit:

| Type | Meaning |
| --- | --- |
| `feat` | new capability |
| `fix` | broken behavior corrected |
| `security` | vulnerability or hardening change |
| `perf` | performance improvement |
| `refactor` | internal change, same behavior |
| `test` | test-only change |
| `docs` | documentation-only change |
| `style` | formatting-only change |
| `deps` | dependency-only update |
| `build` | build/package system |
| `ci` | CI workflow change |
| `migrate` | database/schema/data migration |
| `release` | version/changelog/release metadata |
| `revert` | undo a previous commit |
| `chore` | maintenance that does not fit above |

Use scopes for domain detail instead of inventing more types:

```text
fix(auth): reject expired refresh tokens
feat(admin): add provider diagnostics
docs(api): document sourceFile option
deps(web): update vite
migrate(db): add provider_status table
```

Good scopes are packages, routes, components, commands, adapters, workflows, or config areas.

## Hunk Staging

Use hunk-level staging when a file has separable intent:

```bash
git add -p path/to/file
git diff --cached -- path/to/file
git diff -- path/to/file
```

Stop and ask when:

- hunks overlap too tightly to split safely
- a file combines a behavior change and unrelated cleanup in the same lines
- staging one group would leave the repo unbuildable and verification matters
- the only honest commit would be a mixed-intent commit

## Commit Message Heuristics

Prefer:

```text
feat(scope): add concrete capability
fix(scope): correct concrete broken behavior
security(scope): harden vulnerable surface
perf(scope): reduce slow path cost
test(scope): cover behavior or regression
docs(scope): explain concrete behavior
refactor(scope): simplify without behavior change
style(scope): format without behavior change
deps(scope): update dependency
build(scope): adjust package or build system
ci(scope): update workflow
migrate(scope): change schema or data
release(scope): prepare version metadata
revert(scope): undo prior change
chore(scope): maintain what does not fit above
```

Avoid:

```text
update
misc
changes
cleanup
wip
fix stuff
```

Use the scope that helps a future reader find the affected area: package, route, component, command, adapter, workflow, or config system.

## Confidence Levels

Use confidence to decide whether to proceed:

| Confidence | Meaning | Action |
| --- | --- | --- |
| `high` | Clear intent and ownership | Commit automatically |
| `medium` | Likely split, low risk | Show plan, proceed only if safe |
| `low` | Unclear ownership, mixed hunks, risky files, or side effects | Ask before committing |

Low confidence examples:

- one hunk mixes a bug fix with unrelated cleanup
- deletion could be intentional or accidental
- generated output does not clearly map to a source change
- dependency update and lockfile churn may affect unrelated packages
- security-sensitive files changed without obvious intent

## Special File Handling

| File kind | Rule |
| --- | --- |
| lockfiles | Commit with the `deps` or `build` change that caused them |
| snapshots | Commit with the test or UI behavior change they verify |
| generated files | Commit only when repo convention expects generated output |
| env/local files | Never commit unless explicitly requested |
| large assets | Ask unless clearly part of the change |
| deletions | Verify intentional before staging |
| renames | Detect with `git diff --find-renames` and split from behavior when useful |
| GoalBuddy board bundles | Leave `.goalbuddy-board/` untracked unless explicitly requested |

## Verification Per Commit

Run the smallest meaningful check for each commit group when practical:

- tests for bug fixes and features
- typecheck/build for public API, config, or package boundary changes
- lint/format check for style-only or config changes
- docs/example command when committing runnable docs

If verification is too expensive per commit, run it before the final push/merge and say so in the receipt.

For expensive or environment-sensitive gates, prefer
`scripts/auto-git-gate.mjs --cwd "$PWD" --profile auto -- <command> [args...]`
so the receipt separates environment failures from code failures and records
only the process group started by Auto Git.

## Low Confidence Plan

When classification is uncertain, do not commit. Show:

```markdown
## Proposed Split
- Commit A: message, intent, confidence, files/hunks, why grouped
- Commit B: message, intent, confidence, files/hunks, why grouped
- Leave out: files, why
- Question: the one boundary decision needed
```
