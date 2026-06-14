import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";

const packageInputs = [
  "package.json",
  "pnpm-lock.yaml",
  ".npmrc",
  "bin/**/*.js",
  "scripts/**/*.js",
  "scripts/**/*.mjs",
  "skills/**",
  "docs/gists/**",
  "gists/**",
  "gist-manifest.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "api-contract.json",
  "API_SURFACE.md"
];

export default definePipeline({
  name: "auto-git",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] }),
    manual: trigger.manual()
  },
  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "@async/auto-git" }],
      jobs: [
        "pages",
        "preview",
        "publish",
        "publish-gists",
        "publish-github",
        "release-doctor",
        "snapshot",
        "verify"
      ],
      scripts: {
        "api-surface": "run-task api-surface",
        "api-surface:generate": "run-task api-surface-generate",
        "github:check": "github check",
        "github:generate": "github generate",
        "pack": "run-task pack",
        "publish:github:main": "publish github main --package .",
        "publish:github:pr": "publish github pr --package .",
        "publish:github:release": "publish github release --package .",
        "publish:npm": "publish npm --package .",
        "release:doctor": "release doctor --package .",
        "release:ensure": "release ensure --package .",
        "sync:check": "sync check",
        "sync:generate": "sync generate"
      }
    }
  },
  namedInputs: {
    skills: [
      "skills/**",
      "docs/gists/**",
      "gist-manifest.json"
    ],
    tooling: [
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "tests/**/*.test.js",
      "package.json",
      "pipeline.ts"
    ],
    generated: [
      "gists/**",
      "dist/**",
      ".github/workflows/async-pipeline.yml",
      ".github/async-pipeline.lock.json",
      ".async-pipeline/tasks.lock.json",
      "API_SURFACE.md"
    ],
    docs: [
      "README.md",
      "docs/**/*.md"
    ],
    package: packageInputs
  },
  tasks: {
    "validate-skills": task({
      inputs: ["skills", "tooling"],
      cache: true,
      run: sh`node scripts/validate-skills.js`
    }),
    "check-gists": task({
      dependsOn: ["validate-skills"],
      inputs: ["skills", "tooling", "generated"],
      cache: true,
      run: sh`node scripts/package-gists.js --check`
    }),
    test: task({
      dependsOn: ["check-gists"],
      inputs: ["skills", "tooling", "generated"],
      cache: true,
      run: sh`node --test tests/*.test.js`
    }),
    docs: task({
      description: "Docs site source check for the GitHub Pages README site.",
      inputs: ["docs"],
      cache: true,
      run: sh`node scripts/check-docs-site.js`
    }),
    "api-surface-generate": task({
      description: "Regenerate the @async/auto-git API surface review ledger from the checked-in manifest.",
      inputs: ["api-contract.json"],
      outputs: ["API_SURFACE.md"],
      cache: false,
      // TODO(@async/pipeline): replace this repo-local api-contract task with
      // a pipeline-owned API surface sync command once @async/pipeline exposes one.
      run: sh`pnpm api-contract ledger --manifest api-contract.json --out API_SURFACE.md`
    }),
    "api-surface": task({
      description: "API surface drift checks: validate the @async/auto-git manifest and generated review ledger.",
      inputs: ["api-contract.json", "API_SURFACE.md"],
      cache: true,
      // TODO(@async/pipeline): replace this repo-local api-contract task with
      // a pipeline-owned API surface check once @async/pipeline exposes one.
      run: [
        sh`pnpm api-contract check --manifest api-contract.json`,
        sh`pnpm api-contract ledger --manifest api-contract.json --check API_SURFACE.md`
      ]
    }),
    "sync-check": task({
      description: "Generated workflow, lock, and package scripts still match pipeline.ts.",
      inputs: [
        "pipeline.ts",
        "package.json",
        ".github/workflows/async-pipeline.yml",
        ".github/async-pipeline.lock.json",
        ".async-pipeline/tasks.lock.json"
      ],
      cache: false,
      run: sh`pnpm async-pipeline sync check`
    }),
    build: task({
      description: "Build the generated package runtime surface expected by @async/pipeline's GitHub Packages lifecycle.",
      inputs: ["package"],
      outputs: ["dist/**"],
      cache: false,
      run: sh`node scripts/build-dist.js`
    }),
    pack: task({
      dependsOn: ["test", "docs", "api-surface", "sync-check", "build"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`npm --cache ./.async/npm-cache pack --dry-run`
    }),
    preview: task({
      description: "Same-repo PRs publish an immutable 0.0.0-pr.<n>.sha.<sha> preview to GitHub Packages and update one install comment. Fork PRs skip.",
      dependsOn: ["pack"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline publish github pr --package .`
    }),
    snapshot: task({
      description: "Pushes to main publish an immutable 0.0.0-main.sha.<sha> snapshot to GitHub Packages and move the main dist-tag while the commit is still the branch head.",
      dependsOn: ["pack"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline publish github main --package .`
    }),
    "publish-gists": task({
      description: "Publish the generated Auto Git skill gist packages with the repo-owned gist publisher.",
      dependsOn: ["pack"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`node scripts/publish-gists.js`
    }),
    "publish-github": task({
      description: "Publish the stable GitHub Packages mirror through @async/pipeline.",
      dependsOn: ["release-ensure"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline publish github release --package .`
    }),
    "release-ensure": task({
      description: "Create or verify the release tag and GitHub Release before package publishing.",
      dependsOn: ["pack"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline release ensure --package .`
    }),
    publish: task({
      description: "Publish npm with provenance after the stable GitHub Packages mirror, then verify release state.",
      dependsOn: ["publish-github"],
      inputs: ["package", "generated"],
      cache: false,
      run: [
        sh`pnpm async-pipeline publish npm --package .`,
        sh`pnpm async-pipeline release doctor --package .`
      ]
    }),
    "release-doctor": task({
      description: "Verify tag, npm, GitHub Packages, and GitHub Release state through @async/pipeline.",
      dependsOn: ["pack"],
      inputs: ["package", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline release doctor --package .`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release", "manual"]
    }),
    pages: job({
      target: "docs",
      trigger: ["pr", "main", "manual"],
      github: {
        pages: {
          build: { kind: "jekyll", source: "./docs", destination: "./_site" }
        }
      }
    }),
    preview: job({
      target: "preview",
      trigger: ["pr"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          issues: "write",
          packages: "write",
          pullRequests: "write"
        }
      }
    }),
    snapshot: job({
      target: "snapshot",
      trigger: ["main"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          contents: "write",
          packages: "write"
        }
      }
    }),
    "publish-gists": job({
      target: "publish-gists",
      trigger: ["main", "manual"],
      env: {
        GIST_TOKEN: env.secret("GIST_TOKEN")
      }
    }),
    "publish-github": job({
      target: "publish-github",
      trigger: ["manual"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          contents: "write",
          packages: "write"
        }
      }
    }),
    publish: job({
      target: "publish",
      trigger: ["manual", "release"],
      environment: {
        name: "npm-publish",
        url: "https://www.npmjs.com/package/@async/auto-git"
      },
      requires: {
        provenance: true
      },
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN"),
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      },
      github: {
        permissions: {
          contents: "write",
          packages: "write"
        }
      }
    }),
    "release-doctor": job({
      target: "release-doctor",
      trigger: ["manual"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN"),
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      },
      github: {
        permissions: {
          packages: "write"
        }
      }
    })
  }
});
