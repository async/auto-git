# @async/auto-git API Surface Ledger

This file is the generated review ledger for semantic API contract features. It is current-state contract documentation, not a changelog or tutorial.

## Auto Git CLI

Contract: `@async/auto-git.cli`

### Bins

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `bin.auto-git` | auto-git dispatcher | public | stable | active |  |  |
| `bin.auto-git-finish` | Auto Git finish helper | public | stable | active |  |  |
| `bin.auto-git-gate` | Auto Git verification gate helper | public | stable | active |  |  |
| `bin.auto-git-ledger` | Auto Git ledger inspection helper | public | stable | active |  |  |
| `bin.auto-git-release-doctor` | Auto Git release doctor helper | public | stable | active |  |  |
| `bin.auto-git-release-preflight` | Auto Git release tag preflight helper | public | stable | active |  |  |
| `bin.auto-git-snapshot` | Auto Git topology snapshot helper | public | stable | active |  |  |
| `bin.auto-git-start` | Auto Git start helper | public | stable | active |  |  |

## Auto Git Skill Packages

Contract: `@async/auto-git.skills`

### Gists

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `gist.auto-git` | Generated Auto Git gist package | public | generated | active |  |  |
| `gist.git-history-rewrite` | Generated Git History Rewrite gist package | public | generated | active |  |  |
| `gist.git-intent-audit` | Generated Git Intent Audit gist package | public | generated | active |  |  |

### Skills

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `skill.auto-git` | Auto Git Codex skill | public | stable | active |  |  |
| `skill.git-history-rewrite` | Git History Rewrite Codex skill | public | stable | active |  |  |
| `skill.git-intent-audit` | Git Intent Audit Codex skill | public | stable | active |  |  |

## Auto Git Pipeline Lifecycle

Contract: `@async/auto-git.lifecycle`

### Jobs

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `job.pages` | Generated GitHub Pages job | beta | preview | active |  |  |
| `job.preview` | PR preview package job | beta | preview | active |  |  |
| `job.publish` | npm publish job | beta | preview | active |  |  |
| `job.publish-gists` | Gist publishing job | beta | preview | active |  |  |
| `job.publish-github` | Stable GitHub Packages mirror job | beta | preview | active |  |  |
| `job.release-doctor` | Release doctor job | beta | preview | active |  |  |
| `job.snapshot` | Main snapshot package job | beta | preview | active |  |  |
| `job.verify` | Verification job | public | stable | active |  |  |

## Auto Git Package Metadata

Contract: `@async/auto-git.package`

### Metadata

| Feature | Title | Release | Stability | Lifecycle | Replacement | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `package.api-ledger` | Published API surface ledger files | public | stable | active |  |  |
| `package.dist-runtime` | Generated dist runtime included in package files | public | generated | active |  |  |
| `package.public-access` | Public npm package publish configuration | public | stable | active |  |  |
| `package.type-module` | Node ESM package boundary | public | stable | active |  |  |

## Supported Surfaces

| Contract | Hash | Features |
| --- | --- | --- |
| `@async/auto-git.cli` | `sha256:ac8a756ea253985ee47ae8dc6ddb6eb2fd52c1e625d2147fe29fe0e079c9ac38` | `bin.auto-git`, `bin.auto-git-finish`, `bin.auto-git-gate`, `bin.auto-git-ledger`, `bin.auto-git-release-doctor`, `bin.auto-git-release-preflight`, `bin.auto-git-snapshot`, `bin.auto-git-start` |
| `@async/auto-git.lifecycle` | `sha256:3d4a35779e98a3f64364ad07095f03bfb08dd9e963c83681072deeda89946864` | `job.pages`, `job.preview`, `job.publish`, `job.publish-gists`, `job.publish-github`, `job.release-doctor`, `job.snapshot`, `job.verify` |
| `@async/auto-git.package` | `sha256:720f660ab5ee82ad83ef69f2677593a4d82c4a0a23082de09148edd4d9e4f480` | `package.api-ledger`, `package.dist-runtime`, `package.public-access`, `package.type-module` |
| `@async/auto-git.skills` | `sha256:cd65d953a9808ba1222531e02ce66575d05126c6714b7bcfce1294eb4601068e` | `gist.auto-git`, `gist.git-history-rewrite`, `gist.git-intent-audit`, `skill.auto-git`, `skill.git-history-rewrite`, `skill.git-intent-audit` |

## Required Surfaces

| Contract | Hash | Features |
| --- | --- | --- |
| `@async/pipeline.cli` | `sha256:d98fbabdc807d0a093266381164ba0442c8fe65c172b9fc7009280f91b236e8e` | `cli.github.check`, `cli.github.generate`, `cli.publish.github`, `cli.publish.npm`, `cli.release.doctor`, `cli.run`, `cli.run-task`, `cli.sync.check`, `cli.sync.generate` |
