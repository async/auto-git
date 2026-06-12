# Auto Git

Auto Git is a Codex skill suite for turning repository work into understandable Git history.

## Skills

- `auto-git`: stages, commits, pushes, lands, and fanouts worktrees by change intent.
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

Do not edit `gists/**` by hand. Update `skills/**` or `docs/gists/**`, then run:

```sh
pnpm gists:package
```

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
