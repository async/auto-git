# Changelog

## 0.2.1 - 2026-06-14

- Publish `@async/auto-git` as a public npm package with CLI bins for the Auto Git helper scripts.
- Add release publishing scripts for npm and GitHub Packages, plus a release doctor that checks tag, registry, GitHub Release, and workflow state.
- Update the generated `@async/pipeline` workflow to verify release events and publish with npm provenance.
- Reuse clean same-HEAD release verification after switching from a release branch back to `main`.

## 0.2.0 - 2026-06-14

- Add Auto Git cooperative ledger support for branch-first work, stale run detection, PR handoffs, and lifecycle tracking.
- Preserve the original `checkpoint`, `sync`, `land`, and `fanout` modes while layering branch-first intent routing on top.
- Add release intent handling so release work groups package version changes with changelog or release notes updates.
- Expand snapshot helper and test coverage for occupancy, PR readiness, intent classification, and release metadata.

## 0.1.0 - 2026-06-12

- Initial Auto Git skill suite with `auto-git`, `git-intent-audit`, and `git-history-rewrite`.
- Package flat gist bundles for installing the skills and validating generated gist output.
