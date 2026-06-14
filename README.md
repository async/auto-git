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
metadata under `~/.async/auto-git/v1/repos/<repo-hash>/ledger.json`. Future
chats can see active leases, stale work, verification state, and PR handoffs.
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

Do not edit `gists/**` by hand. Update `skills/**` or `docs/gists/**`, then run:

```sh
pnpm gists:package
```

## Releases

Release commits should use the `release(...)` intent. Keep the `package.json`
version bump, the matching `CHANGELOG.md` section, and any lockfile or package
metadata caused by the bump in the same release commit. `pnpm verify` checks
that the current package version has a changelog entry.

Before creating or pushing a release tag, run the full release gate and the
publish-path preflight on the exact commit that will be tagged. Push the branch
before the tag. If a remote release tag already needs to move, stop for explicit
approval and use only a lease-protected tag update.

## Local Verification

```sh
pnpm install
pnpm verify
```

Useful focused commands:

```sh
pnpm skills:validate
pnpm gists:check
pnpm test
pnpm pipeline:github:check
```

## Gist Publishing

The published gist packages are generated from this repo:

- Auto Git: https://gist.github.com/PatrickJS/2d858aca3211451a0cad7282971beb90
- Git Intent Audit: https://gist.github.com/PatrickJS/b65dd814cde5d9c380b26ecdeba883d4
- Git History Rewrite: https://gist.github.com/PatrickJS/7acdfd0d8d8d3948cbc7003651b68db6

Publishing requires a token that can update those gists:

```sh
GIST_TOKEN=... pnpm gists:publish
```

On GitHub Actions, configure a repository secret named `GIST_TOKEN`. The generated `@async/pipeline` workflow publishes gists on pushes to `main` and on manual dispatch.

## Pipeline

`@async/pipeline` owns the GitHub Actions workflow. Regenerate after editing `pipeline.ts`:

```sh
pnpm pipeline:github:generate
pnpm pipeline:github:check
```
