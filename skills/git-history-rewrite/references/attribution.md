# Attribution

Git commits have one canonical author. When rewritten history collapses, splits, or reorders work from multiple people, preserve attribution explicitly.

## Preserve Evidence

For each replay commit, record:

- original commit hashes
- original subjects
- original authors
- original author emails
- original author dates when relevant
- committer identity used for the rewrite

Use `git show --format=fuller --no-patch <sha>` to inspect metadata.

## Author Selection

Use these rules:

- If one original commit maps to one replay commit, preserve that original author.
- If one original commit splits into multiple replay commits, use the original author for each split commit.
- If multiple commits by the same author collapse into one replay commit, use that author.
- If multiple authors collapse into one replay commit, choose the author who owns the primary code change, then add every other contributor as `Co-authored-by`.
- If authorship is unclear, mark the replay commit `needs-human-review`.

## Commit Body

For rewritten commits derived from prior commits, include traceability:

```text
Original-commits:
- abc1234 old subject
- def5678 old subject

Co-authored-by: Name <email@example.com>
```

Do not include secrets or private tokens from commit messages or diffs.

## Message Corrections

When correcting misleading messages:

- Preserve the actual intent from the diff, not the old subject.
- Prefer the repository's existing commit style if clear.
- Use Auto Git's `commit-by-intent.md` as the canonical style when available.
- Match Auto Git's intent taxonomy, scope guidance, concrete-action wording, and `chore` last-resort rule.
- Keep the subject concrete enough to explain the change later.

Examples:

```text
docs(api): document source file persistence
fix(cli): preserve json output on cache hits
refactor(runtime): separate runner selection
```
