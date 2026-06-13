# Git Topology and Lifecycles

Use this reference for worktree detection, branch handling, push/merge flows, and final cleanup.

## Topology Detection

Prefer the bundled snapshot helper before staging:

```bash
scripts/auto-git-snapshot.mjs --cwd "$PWD" --write-state
```

It batches topology, ahead/behind, dirty inventory, staged state, untracked
files, Git index lock/write state, root and `examples/**/.async/run.lock`
state, package-manager hints, and a recommended execution plan. If it is
unavailable or the snapshot itself fails, run these commands manually:

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
- `dirty main`: main has local edits; checkpoint locally unless the user clearly requested push on main.

## Lock, Profile, and Gate Handling

- If `git.indexWrite.ok` is false, expect Git index writes to require the explicit escalated `git -C <repo> add|commit|push` path in restricted sandboxes. Do not treat that as a code failure.
- If `.git/index.lock` is present, classify it before staging. Remove it only when stale ownership is clear and the user approved lock removal.
- If any `locks.asyncRunLocks[]` entry is present, parse `{ pid, startedAt }` and check `kill -0 <pid>` plus `ps` metadata when useful. Treat missing PIDs as malformed, ESRCH as stale, and inaccessible unrelated PIDs as stale candidates. Remove only confirmed stale locks with approval.
- If the snapshot recommends `executionProfile: loopback-capable`, start with that profile for the expensive gate instead of first running a doomed restricted command.
- Prefer `scripts/auto-git-gate.mjs --cwd "$PWD" --profile auto --quiet-seconds 60 -- <command> [args...]` for long or environment-sensitive verification. It records the PID/process group, duration, failure class, and quiet process-tree diagnostics.
- If npm/pnpm verification fails on HOME cache/log/config writes in a sandbox, retry the same repo-native command with `NO_UPDATE_NOTIFIER=1`, `NPM_CONFIG_CACHE=/private/tmp/<repo>-npm-cache`, and `NPM_CONFIG_LOGS_DIR=/private/tmp/<repo>-npm-logs`.
- If the repo is `async-pipeline`, full `pnpm release:check` should use the loopback-capable profile plus tmp npm cache/log dirs because some tests bind `127.0.0.1` and the release check can spawn npm pack.

## Mode Selection

| User wording | Mode |
| --- | --- |
| "save", "checkpoint", "commit this", "I want to review locally" | `checkpoint` |
| "push", "keep remote latest", "sync this branch" | `sync` |
| "finish", "land", "merge back", "switch back to main" | `land` |
| "multiple agents", "separate features", "worktrees", "do not step on each other" | `fanout` |

When wording is unclear, choose `checkpoint`.

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

## Land

1. Complete `sync`.
2. Run the repo's relevant verification gate.
3. Update local main from the remote default branch.
4. Merge or fast-forward the feature branch according to repo convention.
5. Push main if the user requested remote landing.
6. Switch back to main.
7. Delete the feature branch or worktree only when requested or obviously part of the user's finish instruction.
8. Verify final `git status --short --branch`.

Prefer fast-forward or platform merge flow when that is how the repo works. Do not rewrite shared history unless explicitly requested.

## Fanout Worktrees

Use fanout when multiple features or agents should not share one dirty checkout.

1. Inspect existing worktrees with `git worktree list --porcelain`.
2. Reuse an existing matching worktree when it clearly belongs to the feature.
3. Create a new branch/worktree only when the feature boundary is clear.
4. Use branch names that include the task slug and avoid untrusted text from issues or PRs.
5. Give each worktree one feature ownership boundary.
6. Commit by feature inside that worktree.
7. Integrate from the root/main worktree after review and verification.

Avoid multiple worktrees editing the same files unless the user explicitly accepts conflict risk.

## Cleanup

Only clean up what Auto Git created or what the user explicitly included:

- stale local branch after a confirmed merge
- temporary worktree after confirmed integration
- empty staging state created during the current run
- verification process groups recorded by `auto-git-gate.mjs` for this run
- run locks that are confirmed stale and approved for removal

Never remove untracked user files, caches, ignored directories, or another tool's generated state unless the user asks for that exact cleanup.

Final cleanup receipts should always report:

- worktree status
- `HEAD` versus upstream
- remaining root and nested `.async/run.lock` files
- Auto Git-started verification processes that remain alive
