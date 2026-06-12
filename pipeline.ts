import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "auto-git",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
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
      jobs: ["verify", "publish-gists"],
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
    })
  },
  jobs: {
    verify: job({
      target: ["test", "check-github"],
      trigger: ["pr", "main", "manual"]
    }),
    "publish-gists": job({
      target: "publish-gists",
      trigger: ["main", "manual"],
      env: {
        GIST_TOKEN: env.secret("GIST_TOKEN")
      }
    })
  }
});
