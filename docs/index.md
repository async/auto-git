# Auto Git

Auto Git is the source repo for the Codex skill suite that helps agents turn repository work into reviewable Git history.

## Skills

- `auto-git`: topology detection, commit-by-intent guidance, verification gates, coordinated branches, and release handoff checks.
- `git-intent-audit`: read-only evidence for large or unclear dirty worktrees.
- `git-history-rewrite`: audit-backed local history replay by change intent.

## Maintenance Commands

```sh
pnpm run pipeline:verify
pnpm run pipeline:pages
pnpm run pipeline:preview
pnpm run pipeline:snapshot
pnpm run pipeline:publish-gists
pnpm run pipeline:release-doctor
```

Package consumers can install the CLI from the npm registry:

```sh
pnpm add -g @async/auto-git
```
