# Git History Rewrite Skill

Git History Rewrite is a Codex skill for safely planning or performing local branch history rewrites by change intent. It uses Git Intent Audit evidence, creates backup branches, preserves attribution, and never force-pushes by default.

Companion skills:

- Auto Git: https://gist.github.com/PatrickJS/2d858aca3211451a0cad7282971beb90
- Git Intent Audit: https://gist.github.com/PatrickJS/b65dd814cde5d9c380b26ecdeba883d4

## Files

This gist is flat so it can be copied around easily. Install it with this layout:

```text
git-history-rewrite/
  SKILL.md
  agents/
    openai.yaml
  references/
    rewrite-workflow.md
    attribution.md
```

Gist file mapping:

| Gist file | Skill path |
| --- | --- |
| `git-history-rewrite.SKILL.md` | `SKILL.md` |
| `git-history-rewrite.openai.yaml` | `agents/openai.yaml` |
| `git-history-rewrite.reference-rewrite-workflow.md` | `references/rewrite-workflow.md` |
| `git-history-rewrite.reference-attribution.md` | `references/attribution.md` |

## What It Does

- Starts from a Git Intent Audit report unless fresh equivalent evidence is already available.
- Splits oversized commits by change intent.
- Corrects misleading commit messages using diff evidence.
- Builds replay plans with source commits, paths, authors, and co-author trailers.
- Creates backup branch and rewritten local branch only in explicit local-branch mode.
- Requires tree equality and range-diff review before any later remote update.

## Safety Boundary

This skill may plan a rewrite by default. It may create a local backup and rewritten branch only after explicit user approval in the current request. It must never force-push by default.

## Example Prompts

```text
$git-history-rewrite audit and plan a rewrite of this branch by change intent
```

```text
$git-history-rewrite split the large commits in this branch, preserve authors, and emit a local replay script
```

```text
$git-history-rewrite create a local rewritten branch after using git-intent-audit evidence
```

## Install Notes

For Codex, place the files under your skills directory using the layout above. If your Codex install uses `CODEX_HOME`, use `$CODEX_HOME/skills/git-history-rewrite`; otherwise use your personal skills directory.

Validate after copying:

```bash
python3 path/to/quick_validate.py path/to/skills/git-history-rewrite
```
