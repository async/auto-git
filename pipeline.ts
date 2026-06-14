import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";

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
    github: {
      nodeVersion: 24,
      cache: true
    },
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "@async/auto-git" }],
      jobs: ["verify", "publish-gists", "publish", "release-doctor"],
      scripts: {
        "github:check": "github check",
        "github:generate": "github generate"
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
      "tests/**/*.test.js",
      "package.json",
      "pipeline.ts"
    ],
    generated: [
      "gists/**",
      ".github/workflows/async-pipeline.yml",
      ".github/async-pipeline.lock.json"
    ]
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
    pack: task({
      dependsOn: ["test", "check-github"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`npm pack --dry-run`
    }),
    "check-github": task({
      inputs: ["tooling", "generated"],
      cache: false,
      run: sh`pnpm async-pipeline github check`
    }),
    "publish-gists": task({
      dependsOn: ["test", "check-github"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`node scripts/publish-gists.js`
    }),
    "publish-github": task({
      description: "Mirror the stable npm package to GitHub Packages before npm publishing.",
      dependsOn: ["pack"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`node scripts/publish-github.mjs`
    }),
    "publish-npm": task({
      description: "Publish the stable package to npm with provenance, skipping if the version already exists.",
      dependsOn: ["publish-github"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`node scripts/publish-npm.mjs`
    }),
    "release-doctor": task({
      description: "Diagnose and repair tag, npm, GitHub Packages, GitHub Release, gist, and workflow consistency.",
      dependsOn: ["pack"],
      inputs: ["skills", "tooling", "generated"],
      cache: false,
      run: sh`node scripts/release-doctor.mjs --repair`
    })
  },
  jobs: {
    verify: job({
      target: ["test", "check-github"],
      trigger: ["pr", "main", "manual", "release"]
    }),
    "publish-gists": job({
      target: "publish-gists",
      trigger: ["main", "manual"],
      env: {
        GIST_TOKEN: env.secret("GIST_TOKEN")
      }
    }),
    publish: job({
      target: "publish-npm",
      trigger: ["release", "manual"],
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
          packages: "write"
        }
      }
    }),
    "release-doctor": job({
      target: "release-doctor",
      trigger: ["manual"],
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
    })
  }
});
