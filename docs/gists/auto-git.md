# Auto Git Skill

Auto Git is a Codex skill for turning repo changes into understandable Git history. It auto-detects the current Git topology, detects existing worktrees, groups dirty changes by change intent, then runs the requested lifecycle: checkpoint, sync, land, or fanout.

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
```

Gist file mapping:

| Gist file | Skill path |
| --- | --- |
| `auto-git.SKILL.md` | `SKILL.md` |
| `auto-git.openai.yaml` | `agents/openai.yaml` |
| `auto-git.reference-commit-by-intent.md` | `references/commit-by-intent.md` |
| `auto-git.reference-git-topology-lifecycles.md` | `references/git-topology-lifecycles.md` |

## What It Does

- Detects repo root, branch, upstream, default branch, dirty state, and worktree topology before staging.
- Commits by change intent instead of making one vague bulk commit.
- Reads the code and diffs when there are many unstaged changes, then builds the best commit split.
- Optionally routes large or unclear worktrees to `git-intent-audit` before committing.
- Routes existing commit history cleanup to `git-history-rewrite` instead of performing deep history surgery inside Auto Git.
- Uses hunk-level staging when one file contains separable changes.
- Keeps unrelated user edits out of commits unless the user explicitly includes them.
- Runs the requested Git lifecycle without treating `git add . && git commit` as acceptable automation.

## Modes

| Mode | Use when | Result |
| --- | --- | --- |
| `checkpoint` | You want local commits for review | Change-intent commits only |
| `sync` | You want the current branch pushed | Change-intent commits plus push |
| `land` | You want the branch finished and merged | Commit, push, verify, merge to main, switch back to main |
| `fanout` | You have multiple features or agents | Detect/create isolated worktrees and branch boundaries |

If the mode is unclear, Auto Git should default to `checkpoint`.

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

Creates change-intent commits, then pushes the current branch.

```text
$auto-git land this branch, merge it back to main, and switch me back to main
```

Creates final commits, verifies, pushes, merges or fast-forwards according to repo convention, then returns to main.

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
- merging or landing when the user only asked to commit
- deleting branches or worktrees
- force pushing or rewriting history
- combining unrelated feature groups
- committing files with credential-looking content

Auto Git should not commit generated GoalBuddy board bundles such as `.goalbuddy-board/` unless explicitly requested.

## Install Notes

For Codex, place the files under your skills directory using the layout above. If your Codex install uses `CODEX_HOME`, use `$CODEX_HOME/skills/auto-git`; otherwise use the default personal skills directory for your environment.

After copying, validate with the local skill validator if available:

```bash
python3 path/to/quick_validate.py path/to/skills/auto-git
```

The skill may require a fresh Codex thread before automatic discovery is visible, but explicit `$auto-git` usage should be the intended trigger.
