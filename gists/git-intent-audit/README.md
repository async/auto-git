# Git Intent Audit Skill

Git Intent Audit is a read-only Codex skill for understanding Git changes before committing or rewriting. It audits large dirty worktrees, unclear commit boundaries, oversized commits, mixed-intent commits, and commit message/diff mismatches.

Companion skills:

- Auto Git: https://gist.github.com/PatrickJS/2d858aca3211451a0cad7282971beb90
- Git History Rewrite: https://gist.github.com/PatrickJS/7acdfd0d8d8d3948cbc7003651b68db6

## Files

This gist is flat so it can be copied around easily. Install it with this layout:

```text
git-intent-audit/
  SKILL.md
  agents/
    openai.yaml
  references/
    audit-worktree.md
    audit-history.md
```

Gist file mapping:

| Gist file | Skill path |
| --- | --- |
| `git-intent-audit.SKILL.md` | `SKILL.md` |
| `git-intent-audit.openai.yaml` | `agents/openai.yaml` |
| `git-intent-audit.reference-audit-worktree.md` | `references/audit-worktree.md` |
| `git-intent-audit.reference-audit-history.md` | `references/audit-history.md` |

## What It Does

- Audits dirty worktrees without staging or committing.
- Finds split candidates when a large diff contains multiple change intents.
- Audits existing commits for oversized changes, mixed intent, and misleading messages.
- Suggests corrected commit messages with evidence.
- Hands dirty-worktree plans to Auto Git and history findings to Git History Rewrite.

## Safety Boundary

This skill must not run `git add`, `git commit`, `git reset`, `git rebase`, `git cherry-pick`, `git push`, branch deletion, or worktree deletion. It is evidence-only.

## Example Prompts

```text
$git-intent-audit audit this dirty worktree and tell me how to split it by intent
```

```text
$git-intent-audit check this branch for oversized commits and bad commit messages
```

```text
$git-intent-audit produce evidence for git-history-rewrite before we replay this branch
```

## Install Notes

For Codex, place the files under your skills directory using the layout above. If your Codex install uses `CODEX_HOME`, use `$CODEX_HOME/skills/git-intent-audit`; otherwise use your personal skills directory.

Validate after copying:

```bash
python3 path/to/quick_validate.py path/to/skills/git-intent-audit
```
