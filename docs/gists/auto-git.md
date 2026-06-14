# Auto Git Skill

Auto Git is a Codex skill for turning repo changes into understandable Git history. It auto-detects the current Git topology, detects existing worktrees, claims cooperative run leases, groups dirty changes by change intent, and routes work through local-review checkpoints or coordinated branch/PR/fanout flows.

Optional companion skills:

- [`git-intent-audit`](https://gist.github.com/PatrickJS/b65dd814cde5d9c380b26ecdeba883d4): read-only audit for large dirty worktrees, unclear intent, oversized commits, mixed commits, and message/diff mismatch findings.
- [`git-history-rewrite`](https://gist.github.com/PatrickJS/7acdfd0d8d8d3948cbc7003651b68db6): local branch history replay by change intent, using `git-intent-audit` evidence and backup branches. It never force-pushes by default.

## Files

This gist is flat so it can be copied around easily. Install it with this layout:

```text
auto-git/
  SKILL.md
  agents/
    openai.yaml
  references/
    commit-by-intent.md
    git-topology-lifecycles.md
  scripts/
    auto-git-snapshot.mjs
    auto-git-gate.mjs
```

Gist file mapping:

| Gist file | Skill path |
| --- | --- |
| `auto-git.SKILL.md` | `SKILL.md` |
| `auto-git.openai.yaml` | `agents/openai.yaml` |
| `auto-git.reference-commit-by-intent.md` | `references/commit-by-intent.md` |
| `auto-git.reference-git-topology-lifecycles.md` | `references/git-topology-lifecycles.md` |
| `auto-git.script-auto-git-snapshot.mjs` | `scripts/auto-git-snapshot.mjs` |
| `auto-git.script-auto-git-gate.mjs` | `scripts/auto-git-gate.mjs` |

## What It Does

- Detects repo root, branch, upstream, default branch, dirty state, and worktree topology before staging.
- Uses a compact snapshot helper to detect Git index write capability, run locks, package-manager hints, ledger occupancy, PR handoffs, PR readiness, and the recommended verification profile before expensive commands.
- Supports two workflows: local review for single-chat code review and coordinated branch for multi-chat conflicts, PR handoffs, experiments, and fanouts.
- Tracks cooperative leases and PR handoffs under `~/.async/auto-git/v1/repos/<repo-hash>/ledger.json` without storing raw diffs, prompts, full command output, environment dumps, or secrets.
- Commits by change intent instead of making one vague bulk commit.
- Reads the code and diffs when there are many unstaged changes, then builds the best commit split.
- Optionally routes large or unclear worktrees to `git-intent-audit` before committing.
- Routes existing commit history cleanup to `git-history-rewrite` instead of performing deep history surgery inside Auto Git.
- Uses hunk-level staging when one file contains separable changes.
- Keeps unrelated user edits out of commits unless the user explicitly includes them.
- Runs expensive gates through a small helper when useful so receipts capture PID/process group, duration, execution profile, quiet diagnostics, and environment-vs-code failure classification.
- Runs the requested Git lifecycle without treating `git add . && git commit` as acceptable automation.
- Never merges merely because a PR is ready. Auto Git prepares or records handoffs; merge remains explicit through the `land` lifecycle or a later merge request.

## Lifecycle Modes

Legacy lifecycle modes still exist:

| Mode | Use when | Result |
| --- | --- | --- |
| `checkpoint` | You want local commits for review | Change-intent commits only |
| `sync` | You want the current branch pushed | Change-intent commits plus push |
| `land` | You explicitly want the branch finished and merged | Commit, push, verify, merge to main, switch back to main |
| `fanout` | You have multiple features or agents | Detect/create isolated worktrees and branch boundaries |
| `everything` | You want Auto Git to fully manage git, commits by feature, merge, and release | Start-to-finish ownership with safety gates |

If mode is unclear, Auto Git should default to `checkpoint`.

## Workflows

Auto Git supports two workflows:

| Workflow | Use when | Default result |
| --- | --- | --- |
| `local-review` | You are working in one chat and want to review code as it evolves | Commit by intent in the current checkout/branch |
| `coordinated-branch` | Multiple chats/features may collide, a checkout is occupied, or you ask for branch, PR, fanout, experiment, get-this-in, ship, or merge-ready work | Isolated branch/worktree, ledger lease, verification records, PR handoff when requested |

Plain implementation wording like "fix this", "add this", or "implement this
plan" stays in local-review workflow unless paired with branch/PR/get-this-in,
ship, fanout, experiment, or an occupied checkout.

## Coordinated Intent Overlay

The coordinated workflow sits on top of the old lifecycle modes:

| Intent | Use when | Overlay result |
| --- | --- | --- |
| `merge` | "get this in", "ship", "finish this", "ready to merge" | Isolated branch/worktree, change-intent commits, verification, PR handoff |
| `branch` | "make a branch", "branch this", "put this on a branch", "open a PR" | Isolated branch/worktree and PR handoff |
| `experiment` | "testing something", "experimenting", "try this", "not sure of this approach" | Isolated branch/worktree and local checkpoints only |
| `checkpoint` | "save this", "checkpoint", "commit this locally" | Local change-intent commits only |
| `release` | "release this", "cut v1.2.3", "version bump", "prepare changelog" | Keep version, changelog/release notes, and bump-caused package metadata together |

## Everything Mode

Use this only for explicit requests like "auto-git do everything" or "fully
manage all git, commits by feature, merge, and release." Everything mode wraps
the other lifecycles:

1. Start with `auto-git-start.mjs` to claim the run and choose local-review or
   coordinated-branch workflow.
2. Split and commit by feature/intent.
3. Verify each group and the final repo gate.
4. Sync/push, create or update PR handoffs, land/merge, and release only when
   the request clearly authorizes those steps.
5. Run `auto-git-release-preflight.mjs` before creating or pushing release tags.
6. Push the completed branch with upstream tracking and switch back to main
   before calling the work done, unless the user explicitly asks to stay on the
   branch.
7. Finish with `auto-git-finish.mjs` so PR handoff or pushed merge evidence,
   branch/base push state, return-to-main state, and the ledger receipt are all
   clean.

Everything mode still stops for secrets, unclear commit boundaries, destructive
cleanup, force pushes, failed verification, missing release metadata, or remote
tag movement without explicit approval.

## Ledger States

| State | Meaning |
| --- | --- |
| `free` | No fresh active Auto Git lease blocks the checkout |
| `self` | This run owns the active lease |
| `occupied` | Another fresh Auto Git run owns the checkout |
| `stale` | A lease expired, or an expired run has a PR handoff |
| `abandoned-candidate` | A lease expired, no active Auto Git process is known, and the branch/worktree remains |

Stale entries are advisory. Auto Git can reliably detect stale chats only when those chats used Auto Git and wrote ledger state.

## PR Readiness

| State | Meaning |
| --- | --- |
| `none` | No PR should exist yet, especially experiment/checkpoint intent |
| `draft-pr` | Commits exist but verification is missing/failing or confidence is low |
| `ready-pr` | Branch is clean, ahead of base, and verification passed for current `HEAD` |
| `merge-candidate` | A PR handoff exists and local verification still matches |

## Intent Types

Auto Git should use the most specific type that fits:

```text
feat      new capability
fix       broken behavior corrected
security  vulnerability or hardening change
perf      performance improvement
refactor  internal change, same behavior
test      test-only change
docs      documentation-only change
style     formatting-only change
deps      dependency-only update
build     build/package system
ci        CI workflow change
migrate   database/schema/data migration
release   version/changelog/release metadata
revert    undo a previous commit
chore     maintenance that does not fit above
```

Use scopes for domain detail:

```text
fix(auth): reject expired refresh tokens
feat(admin): add provider diagnostics
docs(api): document sourceFile option
deps(web): update vite
migrate(db): add provider_status table
```

`chore` is the last resort. If `deps`, `build`, `ci`, `release`, `migrate`, `security`, `style`, `test`, `docs`, or `refactor` fits, use that instead.

Release commits are specific: a `release(...)` commit must include the package
version change, normally `package.json`, plus the matching changelog or release
notes update when the repo has one. Include lockfile or package metadata changes
caused by the version bump in the same release commit. Do not hide unrelated
features, fixes, docs, or dependency updates inside release metadata.

Release tags come after exact-commit proof, not before it. Before creating or
pushing a release tag, run the repo's full release gate and publish-path
preflight on the commit that will be tagged: frozen install, lockfile/package
metadata checks, generated-artifact checks, and registry/tag/release existence
checks when applicable. Push the branch before the tag. If a remote release tag
already needs to move, stop for explicit approval and use only a lease-protected
tag update after confirming no package or GitHub Release was published for the
old SHA.

## Confidence Levels

```text
high    clear intent and ownership; commit automatically
medium  likely split and low risk; show plan, then proceed only if safe
low     unclear ownership, mixed hunks, risky files, or side effects; ask before committing
```

Special files need extra care: lockfiles, snapshots, generated files, env/local files, large assets, deletions, renames, and GoalBuddy board bundles.

Use `git-intent-audit` first when a dirty worktree has more than 15 files, more than 500 changed lines, mixed staged/unstaged state, mixed hunks, or low-confidence intent boundaries.

## Example Prompts

```text
$auto-git checkpoint this so I can review locally
```

Creates local commits grouped by change intent and leaves unrelated files unstaged.

```text
$auto-git sync this branch and keep the remote latest
```

Creates change-intent commits, then pushes the current branch when that action is allowed by the request.

```text
$auto-git land this branch, merge it back to main, and switch me back to main
```

Creates final commits, verifies, pushes, merges or fast-forwards because the user explicitly requested `land`, then returns to main.

```text
$auto-git make a branch and PR for this
```

Creates or reuses an isolated branch/worktree, commits by intent, verifies when practical, and prepares a PR handoff.

```text
$auto-git get this fix in
```

Uses an isolated branch/worktree, commits by intent, verifies, and creates or recommends a ready PR. It does not merge automatically.

```text
$auto-git try this approach, not sure yet
```

Uses an isolated branch/worktree and local checkpoints, but does not open a PR until asked.

```text
$auto-git fanout these three features into worktrees so agents do not step on each other
```

Inspects existing worktrees first, reuses matching ones when clear, and creates isolated worktrees only for clear feature boundaries.

```text
auto-git is on; there are a lot of unstaged changes, figure out the best commits by intent
```

Reads status, diffs, nearby tests, docs, routes, package boundaries, config, and generated files to infer intent. If the split is clear, it commits by group. If not, it shows a proposed split and asks for the one boundary decision needed.

## Safety Behavior

Auto Git should ask before:

- pushing when the user only asked for local review
- creating a PR when the user only asked for an experiment or local checkpoint
- merging in all cases unless the user explicitly asks for that later action
- deleting branches or worktrees
- force pushing or rewriting history
- combining unrelated feature groups
- committing files with credential-looking content

Auto Git should not commit generated GoalBuddy board bundles such as `.goalbuddy-board/` unless explicitly requested.

## Helper Scripts

Run the snapshot helper before staging or verification when available:

```bash
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state
```

The snapshot output is compact JSON. Advisory state writes fail soft with
`stateWrite.ok=false`, so an unwritable `~/.async/auto-git` directory does not
block the first move.

For cooperative run leases and PR handoffs:

```bash
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --claim-run "fix auth" --lifecycle checkpoint
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --heartbeat-run "<run-id>"
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --complete-run "<run-id>"
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --record-pr "<run-id>" --pr-url "https://github.com/org/repo/pull/123"
```

The snapshot emits `occupancy`, `handoffs.openPrs`, `recommendedAction`, and `prReadiness` so future chats can continue, supersede, or merge by explicit instruction.

Controller helpers:

```sh
scripts/auto-git-start.mjs --cwd "$PWD" --task "fix this"
scripts/auto-git-ledger.mjs list --cwd "$PWD"
scripts/auto-git-finish.mjs --cwd "$PWD" --run-id "<id>" --complete
scripts/auto-git-release-preflight.mjs --cwd "$PWD" --require-verification
```

`auto-git-finish.mjs` blocks coordinated/everything completion until the branch
is pushed upstream or merged into a pushed base branch, the checkout is switched
back to main/default, a PR handoff or merge is recorded, and the ledger update
succeeds.

For long or environment-sensitive gates, use:

```bash
scripts/auto-git-gate.mjs --cwd "$PWD" --profile auto --quiet-seconds 60 -- pnpm verify
```

The gate helper records only safe metadata: command argv, profile, generated
environment overrides, PID/process group, duration, exit code, dirty
fingerprint, and failure class. It must not store raw diffs, full command
output, secrets, npmrc content, or environment dumps.

## Install Notes

For Codex, place the files under your skills directory using the layout above. If your Codex install uses `CODEX_HOME`, use `$CODEX_HOME/skills/auto-git`; otherwise use the default personal skills directory for your environment.

After copying, validate with the local skill validator if available:

```bash
python3 path/to/quick_validate.py path/to/skills/auto-git
```

The skill may require a fresh Codex thread before automatic discovery is visible, but explicit `$auto-git` usage should be the intended trigger.
