# Git Topology and Lifecycles

Use this reference for local-review commits, worktree detection, branch
handling, cooperative Auto Git leases, PR handoffs, and final cleanup.

## Topology Detection

Prefer the bundled snapshot helper before staging:

```bash
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state
```

It batches topology, ahead/behind, dirty inventory, staged state, untracked
files, Git index lock/write state, root and `examples/**/.async/run.lock`
state, package-manager hints, cooperative ledger occupancy, PR handoffs, PR
readiness, and a recommended execution plan. If it is unavailable or the
snapshot itself fails, run these commands manually:

```bash
git rev-parse --show-toplevel
git status --short --branch
git worktree list --porcelain
git branch --show-current
git remote -v
git symbolic-ref --quiet --short refs/remotes/origin/HEAD
git rev-parse --abbrev-ref @{u}
```

The upstream command can fail on a new local branch; handle that as useful state, not an error.

Classify the checkout:

- `main`: current branch equals the repo default branch or known trunk branch.
- `feature`: named non-main branch in the primary checkout.
- `worktree`: current path appears as a linked worktree path.
- `detached`: no branch name; do not commit until the user confirms or a branch is created.
- `dirty main`: main has local edits; stop to classify inherited work before
  staging. Create a branch in place only when that is safer than moving
  uncommitted changes.

## Ledger, Occupancy, and Stale Runs

Auto Git uses a cooperative ledger under
`~/.async/auto-git/v1/repos/<repo-hash>/ledger.json`. The ledger stores safe
metadata only: run ids, task slugs, intent, branches, worktree paths, base
branches, timestamps, lease expirations, commit SHAs, verification keys, and PR
URLs/statuses. It must not store raw prompts, diffs, full command output,
environment dumps, npmrc content, or secrets.

Useful snapshot commands:

```bash
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --claim-run "fix auth"
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --heartbeat-run "<run-id>"
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --complete-run "<run-id>"
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state --record-pr "<run-id>" --pr-url "https://github.com/org/repo/pull/123"
```

Occupancy states:

| State | Meaning | Default action |
| --- | --- | --- |
| `free` | No fresh active ledger run blocks the checkout | Claim a run before mutating |
| `self` | This run owns the fresh lease | Continue the current branch/worktree |
| `occupied` | Another fresh Auto Git run owns the checkout | Create or reuse an isolated worktree |
| `stale` | A lease expired, or an expired run has a PR handoff | Review the stale run before superseding |
| `abandoned-candidate` | A lease expired, no active Auto Git process is known, and the branch/worktree remains | Inspect or supersede with a new branch |

Stale entries are advisory and are never auto-deleted. Auto Git can reliably
detect stale chats only when those chats used Auto Git and wrote ledger state.

## Lock, Profile, and Gate Handling

- If `git.indexWrite.ok` is false, expect Git index writes to require the explicit escalated `git -C <repo> add|commit|push` path in restricted sandboxes. Do not treat that as a code failure.
- If `.git/index.lock` is present, classify it before staging. Remove it only when stale ownership is clear and the user approved lock removal.
- If any `locks.asyncRunLocks[]` entry is present, parse `{ pid, startedAt }` and check `kill -0 <pid>` plus `ps` metadata when useful. Treat missing PIDs as malformed, ESRCH as stale, and inaccessible unrelated PIDs as stale candidates. Remove only confirmed stale locks with approval.
- If the snapshot recommends `executionProfile: loopback-capable`, start with that profile for the expensive gate instead of first running a doomed restricted command.
- Prefer `scripts/auto-git-gate.mjs --cwd "$PWD" --profile auto --quiet-seconds 60 -- <command> [args...]` for long or environment-sensitive verification. It records the PID/process group, duration, failure class, and quiet process-tree diagnostics.
- If npm/pnpm verification fails on HOME cache/log/config writes in a sandbox, retry the same repo-native command with `NO_UPDATE_NOTIFIER=1`, `NPM_CONFIG_CACHE=/private/tmp/<repo>-npm-cache`, and `NPM_CONFIG_LOGS_DIR=/private/tmp/<repo>-npm-logs`.
- If the repo is `async-pipeline`, full `pnpm release:check` should use the loopback-capable profile plus tmp npm cache/log dirs because some tests bind `127.0.0.1` and the release check can spawn npm pack.

## Lifecycle Mode Selection

Legacy lifecycle modes still apply. Workflow selection, branch coordination,
and PR readiness are overlays on top of these modes, not replacements for them.

| User wording | Mode |
| --- | --- |
| "save", "checkpoint", "commit this", "I want to review locally" | `checkpoint` |
| "push", "keep remote latest", "sync this branch", "publish this branch" | `sync` |
| "finish", "land", "merge back", "switch back to main" | `land` |
| "multiple agents", "separate features", "worktrees", "do not step on each other" | `fanout` |
| "do everything", "everything mode", "fully manage this", "manage all git" | `everything` |

When wording is unclear, choose `checkpoint`.

## Workflow Selection

Auto Git supports two workflows:

| Workflow | Use when | Default action |
| --- | --- | --- |
| `local-review` | One chat is working through code and wants local review/checkpoints, or intent is unclear | Stay in the current checkout/branch and commit by change intent |
| `coordinated-branch` | Multiple chats/features may collide, a checkout is occupied, or the user asks for branch, PR, fanout, experiment, get-this-in, ship, or merge-ready work | Use an isolated branch/worktree, ledger leases, verification records, and PR handoff when requested |

Do not treat plain implementation wording like "fix this", "add this", or
"implement this plan" as a PR/worktree request by itself. Those phrases stay in
local-review workflow unless paired with branch/PR/get-this-in/ship/fanout
language or an occupied checkout.

## Coordinated Intent Overlay

| User wording | Intent | Overlay behavior |
| --- | --- | --- |
| "get this in", "ship", "finish this", "ready to merge" | `merge` | Use an isolated worktree branch and prepare a PR handoff when ready |
| "make a branch", "branch this", "put this on a branch", "open a PR" | `branch` | Always use a branch/worktree and prepare a PR handoff |
| "testing something", "experimenting", "try this", "not sure of this approach" | `experiment` | Use an isolated branch/worktree and local checkpoints only |
| "save", "checkpoint", "commit this locally" | `checkpoint` | Commit locally by intent; no PR unless asked |
| "release this", "cut v1.2.3", "version bump", "prepare changelog" | `release` | Keep version, changelog/release notes, and bump-caused package metadata together |

## Local Review Mutation

Local review is the original Auto Git workflow:

1. Reuse the current checkout/branch when it is free and safe.
2. Build a commit plan from the dirty work.
3. Stage and commit one feature/intent group at a time.
4. Leave unrelated files unstaged.
5. Do not open a PR unless the user asks for publish/PR/get-this-in behavior.

## Coordinated Branch Mutation

Keep trunk clean for coordinated work:

1. If already in an Auto Git-owned branch/worktree, reuse it.
2. If on clean trunk and the coordinated workflow is selected, create or reuse a
   branch named `codex/<task-slug>-<short-run-id>` in an isolated worktree.
3. If trunk is dirty, classify the inherited work before staging. Do not move
   uncommitted changes into a new worktree by guessing.
4. Use one branch/worktree per feature ownership boundary.
5. Avoid multiple worktrees editing the same files unless the user explicitly
   accepts conflict risk.

## Checkpoint

1. Build the commit plan.
2. Stage and commit one feature/intent group at a time.
3. Leave unrelated files unstaged.
4. End with status and commit receipt.

## Sync

1. Complete `checkpoint`.
2. Confirm or create upstream if needed.
3. Pull/rebase only when it is repo convention or needed to avoid rejected push.
4. Push the current branch.
5. Report local and remote branch state.

Never force push unless explicitly requested and `--force-with-lease` is the safest matching command.

## PR Handoff

Use PR handoff when the user has merge or branch intent.

1. Complete the relevant commit-by-intent loop.
2. Run the repo's relevant verification gate.
3. Record successful verification against current `HEAD`.
4. Push/create a PR only when the user asked for branch/PR/publish/get-this-in
   behavior or an established mode allows it.
5. Record the PR with `--record-pr` so future Auto Git runs can discover it.
6. Report whether the branch is `draft-pr`, `ready-pr`, or `merge-candidate`.
7. After the branch is pushed and handoff state is recorded, switch the active
   checkout back to main/default before the final receipt unless the user asked
   to remain on the branch.
8. Never merge merely because a PR is ready. Merge only through the explicit
   `land` lifecycle or a later merge request.

PR readiness states:

| State | Meaning |
| --- | --- |
| `none` | No PR should exist yet, especially experiment/checkpoint intent |
| `draft-pr` | Commits exist but verification is missing/failing or confidence is low |
| `ready-pr` | Branch is clean, ahead of base, and verification passed for current `HEAD` |
| `merge-candidate` | A PR handoff exists and local verification still matches |

## Land

Land remains the legacy lifecycle for explicit finish/merge requests.

1. Complete `sync`.
2. Run the repo's relevant verification gate.
3. Update local main from the remote default branch.
4. Merge or fast-forward the feature branch according to repo convention only
   because the user explicitly requested land/merge behavior.
5. Push main only when the user requested remote landing.
6. Switch back to main when requested.
7. Delete the feature branch or worktree only when requested or obviously part
   of the user's finish instruction.
8. Verify final `git status --short --branch`.

Prefer fast-forward or platform merge flow when that is how the repo works. Do
not rewrite shared history unless explicitly requested.

## Release

Release is a commit intent and a publish handoff, not a replacement for
`checkpoint`, `sync`, or `land`.

Before creating or pushing a release tag, prove the exact release commit:

1. Confirm the release commit includes the package version change, normally
   `package.json`, the matching changelog or release notes update, and lockfile
   or package metadata caused by the version bump.
2. Run the repo's full release gate on the exact commit that will be tagged.
3. Run the publish-path preflight before tagging: frozen install, lockfile or
   package metadata checks, generated-artifact checks, and package registry,
   remote tag, and GitHub Release existence checks when applicable.
4. Push the branch before the tag so the remote branch contains the verified
   commit before any release ref points at it.
5. Create and push the release tag only after the branch push and preflight both
   pass.
6. Create or dispatch publish/release automation according to the repo's
   documented release path.
7. Verify package visibility, release visibility, tag target, and release CI
   before reporting success.

If preflight finds drift after a tag was created locally, move the local tag
before pushing it. If a remote tag was already pushed and the final release
commit changes, do not move it automatically. Stop and ask for explicit
approval, report the old and new tag SHAs, confirm no package or GitHub Release
was published for the old SHA, and use only a lease-protected tag update if
approved. Never rewrite branch history to repair a release tag.

## Everything

Use `everything` only when the user explicitly grants broad Auto Git ownership,
for example "auto-git do everything" or "fully manage all git, commits, merge,
and release."

Everything mode is an execution envelope over the other lifecycles:

1. Start with `auto-git-start.mjs` so workflow mode, occupancy, run id, and
   recommended action are explicit.
2. Split work by feature/intent, not by file bucket. Use `git-intent-audit`
   when the dirty tree is large, mixed, or low-confidence.
3. Commit each intent group with focused verification.
4. Run the repo's final gate before push, PR, land, or release.
5. Use `sync` rules for branch push, `PR Handoff` rules for PR state, `Land`
   rules for merge, and `Release` rules for version/tag/release work.
6. Use `auto-git-ledger.mjs` when handoff or stale state is unclear.
7. Use `auto-git-release-preflight.mjs` before creating or pushing a release
   tag.
8. Push every completed feature/release branch with upstream tracking and switch
   back to main/default before final completion unless the user explicitly asks
   to stay on the branch.
9. Use `auto-git-finish.mjs` for the final receipt and ledger completion; it
   should block coordinated/everything completion if the branch is unpushed, a
   merged base branch is unpushed, or the checkout is still on the branch.
10. The finish receipt must also check PR handoff or pushed merge evidence and
    confirm the ledger update state, so "done" means pushed, handed off or
    integrated, recorded, and back on main/default.
11. Completing from main/default must preserve the completed branch and head in
    the ledger, not overwrite the handoff with the base checkout.

Everything mode does not bypass safety. Stop for secrets, destructive cleanup,
ambiguous commit boundaries, unresolved conflicts, failed verification, force
pushes, remote tag movement, missing release metadata, or unclear merge/release
authority.

## Fanout Worktrees

Use fanout when multiple features or agents should not share one dirty checkout.

1. Inspect existing worktrees with `git worktree list --porcelain`.
2. Reuse an existing matching worktree when it clearly belongs to the feature.
3. Create a new branch/worktree only when the feature boundary is clear.
4. Use branch names that include the task slug and avoid untrusted text from issues or PRs.
5. Give each worktree one feature ownership boundary.
6. Commit by feature inside that worktree.
7. Prepare PR handoffs from each branch after review and verification.

Avoid multiple worktrees editing the same files unless the user explicitly accepts conflict risk.

## Cleanup

Only clean up what Auto Git created or what the user explicitly included:

- stale local branch after a confirmed merge
- temporary worktree after confirmed integration
- empty staging state created during the current run
- verification process groups recorded by `auto-git-gate.mjs` for this run
- run locks that are confirmed stale and approved for removal
- ledger leases that this run claimed and completed

Never remove untracked user files, caches, ignored directories, or another tool's generated state unless the user asks for that exact cleanup.

Final cleanup receipts should always report:

- worktree status
- `HEAD` versus upstream
- remaining root and nested `.async/run.lock` files
- Auto Git-started verification processes that remain alive
- ledger occupancy, stale runs, PR readiness, and open PR handoffs
