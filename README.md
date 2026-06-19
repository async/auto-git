# Auto Git

Auto Git is a Codex skill suite for turning repository work into understandable Git history.

## Skills

- `auto-git`: supports local-review checkpoints plus coordinated worktrees, PR handoffs, and fanouts by change intent.
- `git-intent-audit`: read-only evidence for large dirty worktrees, unclear intent, oversized commits, mixed commits, and message/diff mismatches.
- `git-history-rewrite`: audit-backed local history replay by change intent, preserving authorship and never force-pushing by default.

`auto-git` owns the canonical commit style. The audit and rewrite skills defer to `skills/auto-git/references/commit-by-intent.md` for intent type selection, scope selection, message wording, and `chore` as the last resort.

## Source Layout

```text
skills/          Installable Codex skill folders
docs/gists/      README source for each published gist package
gists/           Generated flat gist packages
scripts/         Validation, packaging, and publishing tools
tests/           Node test suite for package invariants
pipeline.ts      @async/pipeline workflow definition
api-contract.json Semantic API surface manifest
API_SURFACE.md   Generated API surface ledger
```

The commit intent rules live in `skills/auto-git/references/commit-by-intent.md`.
Use the most specific intent prefix that fits:

```text
feat: new capability
fix: broken behavior corrected
security: vulnerability or hardening change
perf: performance improvement
refactor: internal change, same behavior
test: test-only change
docs: documentation-only change
style: formatting-only change
deps: dependency-only update
build: build/package system
ci: CI workflow change
migrate: database/schema/data migration
release: version/changelog/release metadata
revert: undo a previous commit
chore: maintenance that does not fit above
```

Use `chore: ` last. If `deps: `, `build: `, `ci: `, `release: `,
`migrate: `, `security: `, `style: `, `test: `, `docs: `, or
`refactor: ` fits, use that more specific intent instead.

Auto Git supports two workflows. Local review is the original single-chat flow:
commit by intent in the current checkout so code can be reviewed as it evolves.
Coordinated branch is the multi-chat flow: when work may collide, or the user
asks for branch/PR/fanout/experiment/get-this-in/ship, Auto Git keeps trunk as
the coordination base and uses isolated branches/worktrees plus safe ledger
metadata under `~/.async/auto-git/v1/repos/<repo-hash>/ledger.json`. Live run
leases also use Async lock records under
`~/.async/locks/auto-git/repos/<repo-hash>/runs/*.lease.json`, with completion
receipts under `~/.async/locks/auto-git/history/`. Future chats can see active
leases, stale work, verification state, and PR handoffs.
Auto Git never merges merely because a PR is ready; merge stays tied to
explicit `land` or later merge intent.

When the user says "auto-git do everything", Auto Git can take start-to-finish
ownership across git status, commit-by-feature, verification, sync/PR handoff,
land/merge, and release. That mode still stops for safety gates such as
secrets, destructive cleanup, failed verification, force pushes, remote tag
movement, and missing release metadata.

Done means cleaned up, not just committed: coordinated/everything branch work
should push the completed branch with upstream tracking and switch back to main
before the final receipt unless the user explicitly asks to stay on the branch.
The finish receipt should also check PR handoff or pushed merge evidence and
confirm the ledger update, so completed work is either handed off, integrated,
or explicitly blocked.
When finish runs after switching back to main, the ledger should still preserve
the completed branch and head for later handoff.

Do not edit `gists/**` by hand. Update `skills/**` or `docs/gists/**`, then run:

```sh
pnpm run gists:package
```

That command is the source-to-generated implementation step for gist packages.
Normal verification and publishing still route through the pipeline-owned
scripts below.

## Helper CLI

The npm package exposes an `auto-git` dispatcher plus individual helper bins:

```sh
auto-git snapshot --cwd "$PWD" --write-state
auto-git gate --cwd "$PWD" --profile auto -- pnpm run pipeline:verify
auto-git release-preflight --cwd "$PWD" --require-verification
```

When `auto-git` runs inside this source checkout, it dispatches to the local
`skills/auto-git/scripts/*` helpers so development uses the working tree copy.
When installed globally, the same commands dispatch to the packaged helpers.
The copied Codex skill can still fall back to its local `scripts/*.mjs` files
when the npm CLI is not on `PATH`.

## Releases

Release commits should use the `release(...)` intent. Keep the `package.json`
version bump, the matching `CHANGELOG.md` section, and any lockfile or package
metadata caused by the bump in the same release commit. `pnpm run pipeline:verify` checks
that the current package version has a changelog entry.

Before release, run the full release gate on the exact commit that will be
published. Push and merge the release-prep branch before using the generated
workflow. If a remote release tag already exists and does not match the release
commit, stop for explicit approval; do not move it from the local machine.

Published releases have four public surfaces that must agree: the git tag,
GitHub Release, npm package, and GitHub Packages mirror. Normal releases use the
generated `@async/pipeline` workflow with npm provenance:

```sh
pnpm run pipeline:verify -- --force
# In GitHub Actions, run "Async Pipeline" with the publish job selected.
pnpm run pipeline:release:doctor
```

The generated workflow creates or verifies the tag and GitHub Release, publishes
the GitHub Packages mirror first, then publishes npm.
`pnpm run pipeline:release:doctor` diagnoses missing or drifted tag/npm/GitHub
state and names only repairs that are safe to run.

## Local Verification

```sh
pnpm install
pnpm run pipeline:verify
```

Useful focused commands:

```sh
pnpm run pipeline:api-surface
pnpm run pipeline:pack
pnpm run pipeline:pages
pnpm run pipeline:sync:check
pnpm run pipeline:github:check
pnpm run pipeline:release:doctor
```

## Gist Publishing

The published gist packages are generated from this repo:

- Auto Git: https://gist.github.com/PatrickJS/2d858aca3211451a0cad7282971beb90
- Git Intent Audit: https://gist.github.com/PatrickJS/b65dd814cde5d9c380b26ecdeba883d4
- Git History Rewrite: https://gist.github.com/PatrickJS/7acdfd0d8d8d3948cbc7003651b68db6

Publishing requires a token that can update those gists:

```sh
GIST_TOKEN=... pnpm run pipeline:publish-gists
```

On GitHub Actions, configure a repository secret named `GIST_TOKEN`. The
generated `@async/pipeline` workflow publishes gists on pushes to `main`; manual
publishing uses the generated workflow dispatch `job` selector with
`publish-gists`.

The lower-level `gists:*` scripts are implementation commands used by pipeline
tasks and source-to-generated packaging checks.

## Pipeline

`@async/pipeline` owns the GitHub Actions workflow. Regenerate after editing `pipeline.ts`:

```sh
pnpm run pipeline:sync:generate
pnpm run pipeline:sync:check
```
