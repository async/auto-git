import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { expectedGistFiles, readManifest, rootDir } from "../scripts/skill-packages.js";

test("manifest packages every skill into flat gist files", async () => {
  const manifest = await readManifest();
  assert.deepEqual(
    manifest.skills.map((skill) => skill.name).sort(),
    ["auto-git", "git-history-rewrite", "git-intent-audit"]
  );

  for (const skill of manifest.skills) {
    const files = await expectedGistFiles(skill);
    assert.ok(files.has("README.md"), `${skill.name} packages README.md`);
    assert.ok(files.has(`${skill.name}.SKILL.md`), `${skill.name} packages SKILL.md`);
    assert.ok(files.has(`${skill.name}.openai.yaml`), `${skill.name} packages openai.yaml`);
    if (skill.name === "auto-git") {
      assert.ok(files.has("auto-git.script-auto-git-snapshot.mjs"), "auto-git packages snapshot helper");
      assert.ok(files.has("auto-git.script-auto-git-gate.mjs"), "auto-git packages gate helper");
      assert.ok(files.has("auto-git.script-auto-git-start.mjs"), "auto-git packages start helper");
      assert.ok(files.has("auto-git.script-auto-git-ledger.mjs"), "auto-git packages ledger helper");
      assert.ok(files.has("auto-git.script-auto-git-finish.mjs"), "auto-git packages finish helper");
      assert.ok(files.has("auto-git.script-auto-git-release-preflight.mjs"), "auto-git packages release preflight helper");
    }
  }
});

test("package exposes publishable Auto Git CLI bins", async () => {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig.access, "public");
  assert.equal(packageJson.devDependencies["@async/pipeline"], "0.2.4");
  assert.equal(packageJson.scripts["release:publish"], "node scripts/publish-npm.mjs");
  assert.equal(packageJson.scripts["release:doctor"], "node scripts/release-doctor.mjs");

  for (const [name, relativePath] of Object.entries(packageJson.bin)) {
    const filePath = path.join(rootDir, relativePath);
    const fileStat = await stat(filePath);
    assert.notEqual(fileStat.mode & 0o111, 0, `${name} points at an executable file`);
  }
});

test("companion skills use Auto Git as commit-style source", async () => {
  const audit = await readFile(path.join(rootDir, "skills/git-intent-audit/SKILL.md"), "utf8");
  const rewrite = await readFile(path.join(rootDir, "skills/git-history-rewrite/SKILL.md"), "utf8");
  assert.match(audit, /Auto Git's commit style as the source of truth/);
  assert.match(rewrite, /using Auto Git's commit-by-intent style/);
});

test("auto-git release guidance requires version and changelog metadata", async () => {
  const commitByIntent = await readFile(path.join(rootDir, "skills/auto-git/references/commit-by-intent.md"), "utf8");
  const topology = await readFile(path.join(rootDir, "skills/auto-git/references/git-topology-lifecycles.md"), "utf8");
  const readme = await readFile(path.join(rootDir, "docs/gists/auto-git.md"), "utf8");
  assert.match(commitByIntent, /`release\(\.\.\.\)` commit must include the\s+package version change, normally `package\.json`/);
  assert.match(commitByIntent, /matching changelog or\s+release notes update/);
  assert.match(commitByIntent, /Keep versioned changelog sections with the release commit/);
  assert.match(topology, /Before creating or pushing a release tag, prove the exact release commit/);
  assert.match(topology, /Run the publish-path preflight before tagging/);
  assert.match(topology, /do not move it automatically/);
  assert.match(topology, /lease-protected tag update/);
  assert.match(readme, /package\s+version change, normally `package\.json`/);
  assert.match(readme, /matching changelog or release\s+notes update/);
  assert.match(readme, /Release tags come after exact-commit proof/);
  assert.match(readme, /Push the branch before the tag/);
});

test("auto-git docs preserve local-review and coordinated-branch workflows", async () => {
  const skill = await readFile(path.join(rootDir, "skills/auto-git/SKILL.md"), "utf8");
  const topology = await readFile(path.join(rootDir, "skills/auto-git/references/git-topology-lifecycles.md"), "utf8");
  const readme = await readFile(path.join(rootDir, "docs/gists/auto-git.md"), "utf8");

  for (const content of [skill, topology, readme]) {
    assert.match(content, /local-review/);
    assert.match(content, /coordinated-branch/);
    assert.match(content, /fix this[\s\S]+add this[\s\S]+implement[\s\S]+local-review/);
  }
});

test("auto-git docs describe everything mode and controller helpers", async () => {
  const skill = await readFile(path.join(rootDir, "skills/auto-git/SKILL.md"), "utf8");
  const topology = await readFile(path.join(rootDir, "skills/auto-git/references/git-topology-lifecycles.md"), "utf8");
  const readme = await readFile(path.join(rootDir, "docs/gists/auto-git.md"), "utf8");

  for (const content of [skill, topology, readme]) {
    assert.match(content, /Everything mode/i);
    assert.match(content, /commit[s]? by feature|commit-by-feature/i);
    assert.match(content, /auto-git-start\.mjs/);
    assert.match(content, /auto-git-finish\.mjs/);
    assert.match(content, /auto-git-release-preflight\.mjs/);
    assert.match(content, /push[\s\S]+branch[\s\S]+switch\s+back to main|switch\s+back to main[\s\S]+push[\s\S]+branch/i);
    assert.match(content, /PR[\s\S]+merge[\s\S]+ledger|ledger[\s\S]+PR[\s\S]+merge/i);
  }
});

test("package version has a matching changelog section", async () => {
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const changelog = await readFile(path.join(rootDir, "CHANGELOG.md"), "utf8");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.match(changelog, new RegExp(`^## ${escapeRegExp(packageJson.version)}(?:\\s|-|$)`, "m"));
});

test("history rewrite safety recipe preserves final tree and co-author trailer", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "auto-git-history-"));
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Codex Tester"]);
    git(repo, ["config", "user.email", "codex@example.com"]);

    await writeProjectFile(repo, "src/app.js", "export const value = 'v1';\n");
    commit(repo, "chore(repo): initial fixture", "Setup <setup@example.com>");

    git(repo, ["switch", "-c", "feature/messy"]);
    await writeProjectFile(repo, "src/app.js", "export const value = 'v2';\n");
    await writeProjectFile(repo, "docs/app.md", "# App\n\nv2\n");
    commit(repo, "docs(app): update app docs", "Alice <alice@example.com>");

    await writeProjectFile(repo, "tests/app.test.js", "import { value } from '../src/app.js';\nassert.equal(value, 'v2');\n");
    commit(repo, "update tests", "Bob <bob@example.com>");

    const oldHead = git(repo, ["rev-parse", "HEAD"]);
    const base = git(repo, ["merge-base", "main", "HEAD"]);
    git(repo, ["branch", "backup/feature-messy-before-history-rewrite-test", oldHead]);
    git(repo, ["switch", "-c", "rewrite/feature-messy-by-intent-test", base]);

    git(repo, ["checkout", oldHead, "--", "src/app.js", "tests/app.test.js"]);
    git(repo, ["add", "src/app.js", "tests/app.test.js"]);
    git(repo, [
      "commit",
      "--author",
      "Alice <alice@example.com>",
      "-m",
      "fix(app): update runtime value",
      "-m",
      "Original-commits:\n- runtime/docs source commit\n- test source commit\n\nCo-authored-by: Bob <bob@example.com>"
    ]);

    git(repo, ["checkout", oldHead, "--", "docs/app.md"]);
    git(repo, ["add", "docs/app.md"]);
    git(repo, ["commit", "--author", "Alice <alice@example.com>", "-m", "docs(app): document updated value"]);

    git(repo, ["diff", "--quiet", oldHead, "HEAD"]);
    const body = git(repo, ["log", "--format=%B", "--max-count=2"]);
    assert.match(body, /Co-authored-by: Bob <bob@example.com>/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("auto-git snapshot fails soft when advisory state is not writable", async () => {
  const repo = await createFixtureRepo("auto-git-state-soft-");
  try {
    const stateHomeFile = path.join(repo, "not-a-directory");
    await writeFile(stateHomeFile, "file\n");

    const result = snapshot(repo, ["--write-state"], { AUTO_GIT_STATE_HOME: stateHomeFile });
    assert.equal(result.ok, true);
    assert.equal(result.stateWrite.ok, false);
    assert.match(result.stateWrite.reason, /not-a-directory|ENOTDIR|EEXIST|file exists/i);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("auto-git snapshot discovers nested async run locks", async () => {
  const repo = await createFixtureRepo("auto-git-nested-lock-");
  try {
    await mkdir(path.join(repo, "examples/runtime-middleware-stack/.async"), { recursive: true });
    await writeFile(
      path.join(repo, "examples/runtime-middleware-stack/.async/run.lock"),
      JSON.stringify({ pid: 999999999, startedAt: "2026-06-13T00:00:00.000Z" })
    );

    const result = snapshot(repo);
    const nested = result.snapshot.locks.asyncRunLocks.find(
      (lock) => lock.path === "examples/runtime-middleware-stack/.async/run.lock"
    );
    assert.ok(nested);
    assert.equal(nested.status, "stale");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("auto-git snapshot classifies inaccessible unrelated pids as stale candidates", async () => {
  const repo = await createFixtureRepo("auto-git-pid-reuse-");
  try {
    await mkdir(path.join(repo, ".async"), { recursive: true });
    await writeFile(
      path.join(repo, ".async/run.lock"),
      JSON.stringify({ pid: 4242, startedAt: "2026-06-13T00:00:00.000Z" })
    );

    const result = snapshot(repo, [], {
      AUTO_GIT_PID_PROBE_FIXTURE: JSON.stringify({ 4242: { status: "active-inaccessible" } }),
      AUTO_GIT_PS_FIXTURE: JSON.stringify({
        4242: { pid: 4242, ppid: 1, pgid: 4242, command: "launchd", args: "/sbin/launchd" }
      })
    });

    assert.equal(result.snapshot.locks.asyncRun.status, "stale-candidate");
    assert.equal(result.snapshot.locks.asyncRun.process.argsIncludesRepoRoot, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("auto-git snapshot promotes async-pipeline hints into an execution plan", async () => {
  const repo = await createFixtureRepo("async-pipeline-");
  try {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify(
        {
          name: "async-pipeline-workspace",
          packageManager: "pnpm@10.20.0",
          scripts: { "release:check": "pnpm build" }
        },
        null,
        2
      )
    );

    const result = snapshot(repo);
    assert.equal(result.snapshot.executionPlan.verification.name, "pnpm release:check");
    assert.equal(result.snapshot.executionPlan.verification.executionProfile, "loopback-capable");
    assert.equal(result.snapshot.executionPlan.verification.env.NO_UPDATE_NOTIFIER, "1");
    assert.ok(
      result.snapshot.packageManager.hints.some((hint) => hint.id === "async-pipeline-release-check")
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("auto-git snapshot records lease lifecycle and stale occupancy", async () => {
  const repo = await createFixtureRepo("auto-git-lease-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-lease-state-"));
  try {
    let result = snapshot(
      repo,
      ["--write-state", "--claim-run", "get this in now", "--run-id", "run-1", "--lease-ttl-ms", "1000"],
      { AUTO_GIT_STATE_HOME: stateHome, AUTO_GIT_NOW: "2026-06-13T00:00:00.000Z" }
    );
    assert.equal(result.snapshot.occupancy.status, "self");
    assert.equal(result.snapshot.occupancy.activeRuns[0].id, "run-1");
    assert.equal(result.snapshot.occupancy.activeRuns[0].intent, "merge");

    result = snapshot(repo, ["--write-state", "--heartbeat-run", "run-1", "--lease-ttl-ms", "1000"], {
      AUTO_GIT_STATE_HOME: stateHome,
      AUTO_GIT_NOW: "2026-06-13T00:00:00.500Z"
    });
    assert.equal(result.snapshot.occupancy.status, "self");
    assert.equal(result.snapshot.occupancy.activeRuns[0].leaseExpiresAt, "2026-06-13T00:00:01.500Z");

    result = snapshot(repo, [], {
      AUTO_GIT_STATE_HOME: stateHome,
      AUTO_GIT_NOW: "2026-06-13T00:00:03.000Z"
    });
    assert.equal(result.snapshot.occupancy.status, "abandoned-candidate");
    assert.equal(result.snapshot.occupancy.staleRuns[0].status, "abandoned-candidate");

    result = snapshot(repo, ["--write-state", "--complete-run", "run-1"], {
      AUTO_GIT_STATE_HOME: stateHome,
      AUTO_GIT_NOW: "2026-06-13T00:00:04.000Z"
    });
    assert.equal(result.snapshot.occupancy.status, "free");
    assert.equal(result.snapshot.occupancy.activeRuns.length, 0);
    assert.equal(result.snapshot.occupancy.staleRuns.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git snapshot classifies user intent for local review and coordinated routing", async () => {
  const cases = [
    ["fix this bug", "unknown", "checkpoint"],
    ["please implement this plan", "unknown", "checkpoint"],
    ["get this in", "merge", "checkpoint"],
    ["ship this change", "merge", "checkpoint"],
    ["make a branch for the docs", "branch", "checkpoint"],
    ["open a PR for the docs", "branch", "checkpoint"],
    ["testing something risky", "experiment", "checkpoint"],
    ["checkpoint this locally", "checkpoint", "checkpoint"],
    ["release this package", "release", "checkpoint"],
    ["cut v1.2.3", "release", "checkpoint"],
    ["version bump and prepare changelog", "release", "checkpoint"],
    ["sync this branch", "unknown", "sync"],
    ["land this branch", "merge", "land"],
    ["fanout these worktrees", "unknown", "fanout"],
    ["auto-git do everything", "unknown", "everything"]
  ];

  for (const [phrase, intent, lifecycle] of cases) {
    const repo = await createFixtureRepo(`auto-git-intent-${lifecycle}-${intent}-`);
    const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-intent-state-${lifecycle}-${intent}-`));
    try {
      const result = snapshot(repo, ["--write-state", "--claim-run", phrase, "--run-id", `run-${lifecycle}-${intent}`], {
        AUTO_GIT_STATE_HOME: stateHome
      });
      assert.equal(result.snapshot.occupancy.status, "self");
      assert.equal(result.snapshot.occupancy.activeRuns[0].intent, intent);
      assert.equal(result.snapshot.occupancy.activeRuns[0].lifecycle, lifecycle);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  }
});

test("auto-git snapshot keeps local review on trunk and isolates coordinated work", async () => {
  const repo = await createFixtureRepo("auto-git-worktree-routing-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-worktree-routing-state-"));
  try {
    let result = snapshot(repo, [], { AUTO_GIT_STATE_HOME: stateHome });
    assert.equal(result.snapshot.occupancy.status, "free");
    assert.equal(result.snapshot.workflowMode, "local-review");
    assert.equal(result.snapshot.recommendedAction, "claim-run-and-continue-local-review");

    result = snapshot(repo, ["--write-state", "--claim-run", "get this in", "--run-id", "merge-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.snapshot.occupancy.status, "self");
    assert.equal(result.snapshot.workflowMode, "coordinated-branch");
    assert.equal(result.snapshot.recommendedAction, "create-or-reuse-isolated-worktree-for-coordinated-run");

    result = snapshot(repo, ["--write-state", "--complete-run", "merge-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.snapshot.occupancy.status, "free");

    result = snapshot(repo, ["--write-state", "--claim-run", "review this locally", "--run-id", "other-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.snapshot.occupancy.status, "self");
    assert.equal(result.snapshot.workflowMode, "local-review");

    result = snapshot(repo, [], { AUTO_GIT_STATE_HOME: stateHome });
    assert.equal(result.snapshot.occupancy.status, "occupied");
    assert.equal(result.snapshot.workflowMode, "coordinated-branch");
    assert.equal(result.snapshot.recommendedAction, "create-or-reuse-isolated-worktree");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git controller scripts start, list, and block unsafe finish", async () => {
  const repo = await createFixtureRepo("auto-git-controllers-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-controllers-state-"));
  try {
    let result = script("auto-git-start.mjs", repo, ["--task", "fix this locally", "--run-id", "local-run", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 0, result.stderr);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.workflowMode, "local-review");
    assert.equal(payload.recommendedAction, "commit-locally-for-review");

    result = script("auto-git-start.mjs", repo, ["--task", "auto-git do everything", "--run-id", "everything-run", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 0, result.stderr);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.lifecycle, "everything");
    assert.equal(payload.workflowMode, "coordinated-branch");

    result = script("auto-git-ledger.mjs", repo, ["list", "--json"], { AUTO_GIT_STATE_HOME: stateHome });
    assert.equal(result.status, 0, result.stderr);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.ledger.runCount, 2);
    assert.ok(payload.runs.some((run) => run.id === "everything-run"));

    await writeProjectFile(repo, "src/dirty.js", "export const dirty = true;\n");
    result = script(
      "auto-git-finish.mjs",
      repo,
      ["--run-id", "everything-run", "--complete", "--json"],
      { AUTO_GIT_STATE_HOME: stateHome }
    );
    assert.equal(result.status, 1);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.ok(payload.blockers.includes("worktree has uncommitted changes"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git finish requires pushed branch and return to main for everything runs", async () => {
  const repo = await createFixtureRepo("auto-git-finish-main-");
  const remote = await mkdtemp(path.join(tmpdir(), "auto-git-finish-remote-"));
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-finish-state-"));
  try {
    git(remote, ["init", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["switch", "-c", "codex/finish-smart"]);
    await writeProjectFile(repo, "src/feature.js", "export const feature = true;\n");
    commit(repo, "feat(auto-git): prove finish branch handoff", "Codex Tester <codex@example.com>");
    const featureHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["push", "-u", "origin", "codex/finish-smart"]);

    snapshot(repo, ["--write-state", "--claim-run", "auto-git do everything", "--run-id", "finish-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    snapshot(
      repo,
      ["--write-state", "--record-verification", "pnpm verify", "--exit-code", "0", "--run-id", "finish-run"],
      { AUTO_GIT_STATE_HOME: stateHome }
    );

    let result = script("auto-git-finish.mjs", repo, ["--run-id", "finish-run", "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 1);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.branchCompletion.pushed, true);
    assert.equal(payload.branchCompletion.returnedToBase, false);
    assert.equal(payload.handoffCheck.satisfied, false);
    assert.ok(payload.blockers.some((blocker) => blocker.includes("switch back to main")));
    assert.ok(payload.blockers.some((blocker) => blocker.includes("no recorded PR handoff")));

    git(repo, ["switch", "main"]);
    result = script(
      "auto-git-finish.mjs",
      repo,
      [
        "--run-id",
        "finish-run",
        "--record-pr",
        "https://github.com/async/auto-git/pull/123",
        "--pr-number",
        "123",
        "--complete",
        "--json"
      ],
      {
        AUTO_GIT_STATE_HOME: stateHome
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.branchCompletion.pushed, true);
    assert.equal(payload.branchCompletion.returnedToBase, true);
    assert.equal(payload.handoffCheck.satisfied, true);
    assert.equal(payload.handoffCheck.pr.url, "https://github.com/async/auto-git/pull/123");
    assert.equal(payload.ledger.status, "completed");
    const ledger = JSON.parse(await readFile(payload.ledger.path, "utf8"));
    const ledgerRun = ledger.runs.find((entry) => entry.id === "finish-run");
    assert.equal(ledgerRun.branch, "codex/finish-smart");
    assert.equal(ledgerRun.head, featureHead);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git finish accepts pushed merge evidence without PR handoff", async () => {
  const repo = await createFixtureRepo("auto-git-finish-merge-");
  const remote = await mkdtemp(path.join(tmpdir(), "auto-git-finish-merge-remote-"));
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-finish-merge-state-"));
  try {
    git(remote, ["init", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["switch", "-c", "codex/finish-merged"]);
    await writeProjectFile(repo, "src/merged.js", "export const merged = true;\n");
    commit(repo, "feat(auto-git): prove finish merge evidence", "Codex Tester <codex@example.com>");
    const featureHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["push", "-u", "origin", "codex/finish-merged"]);

    snapshot(repo, ["--write-state", "--claim-run", "auto-git do everything", "--run-id", "merge-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    snapshot(repo, ["--write-state", "--record-verification", "pnpm verify", "--exit-code", "0", "--run-id", "merge-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });

    git(repo, ["switch", "main"]);
    git(repo, ["merge", "--ff-only", "codex/finish-merged"]);
    git(repo, ["branch", "-d", "codex/finish-merged"]);

    let result = script("auto-git-finish.mjs", repo, ["--run-id", "merge-run", "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 1);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.handoffCheck.satisfied, true);
    assert.equal(payload.handoffCheck.merge.mergedIntoBase, true);
    assert.equal(payload.branchCompletion.exists, false);
    assert.ok(payload.blockers.some((blocker) => blocker.includes("base branch main has 1 unpushed commit")));

    git(repo, ["push", "origin", "main"]);
    result = script("auto-git-finish.mjs", repo, ["--run-id", "merge-run", "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.handoffCheck.satisfied, true);
    assert.equal(payload.handoffCheck.merge.mergedIntoBase, true);
    assert.equal(payload.handoffCheck.merge.basePushed, true);
    assert.equal(payload.branchCompletion.returnedToBase, true);
    assert.equal(payload.ledger.status, "completed");
    const ledger = JSON.parse(await readFile(payload.ledger.path, "utf8"));
    const ledgerRun = ledger.runs.find((entry) => entry.id === "merge-run");
    assert.equal(ledgerRun.branch, "codex/finish-merged");
    assert.equal(ledgerRun.head, featureHead);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git release preflight blocks missing changelog and accepts clean release metadata", async () => {
  const repo = await createFixtureRepo("auto-git-release-preflight-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-release-preflight-state-"));
  try {
    await writeProjectFile(
      repo,
      "package.json",
      JSON.stringify({ name: "fixture", version: "1.2.3", type: "module" }, null, 2) + "\n"
    );
    commit(repo, "release(fixture): prepare 1.2.3 metadata", "Codex Tester <codex@example.com>");

    let result = script("auto-git-release-preflight.mjs", repo, ["--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 1);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.safeToTag, false);
    assert.ok(payload.blockers.some((blocker) => blocker.includes("changelog")));

    await writeProjectFile(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.3 - 2026-06-14\n\n- Release metadata.\n");
    commit(repo, "release(fixture): add 1.2.3 changelog", "Codex Tester <codex@example.com>");
    result = script("auto-git-release-preflight.mjs", repo, ["--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.safeToTag, true);
    assert.equal(payload.releaseNotes.hasMatchingSection, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git release preflight reuses clean same-head verification after branch changes", async () => {
  const repo = await createFixtureRepo("auto-git-release-preflight-reuse-");
  const remote = await mkdtemp(path.join(tmpdir(), "auto-git-release-preflight-reuse-remote-"));
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-release-preflight-reuse-state-"));
  try {
    git(remote, ["init", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    await writeProjectFile(
      repo,
      "package.json",
      JSON.stringify({ name: "fixture", version: "1.2.3", type: "module" }, null, 2) + "\n"
    );
    await writeProjectFile(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.3 - 2026-06-14\n\n- Release metadata.\n");
    commit(repo, "release(fixture): prepare 1.2.3", "Codex Tester <codex@example.com>");
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["switch", "-c", "codex/release-fixture"]);
    git(repo, ["push", "-u", "origin", "codex/release-fixture"]);

    snapshot(repo, ["--write-state", "--record-verification", "pnpm verify", "--exit-code", "0"], {
      AUTO_GIT_STATE_HOME: stateHome
    });

    git(repo, ["switch", "main"]);
    const result = script("auto-git-release-preflight.mjs", repo, ["--require-verification", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.safeToTag, true);
    assert.equal(payload.verification.matchType, "clean-same-head");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("release doctor reports healthy and repairable package states", async () => {
  const healthy = releaseDoctorFacts();
  let result = releaseDoctor(healthy);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let payload = JSON.parse(result.stdout);
  assert.equal(payload.healthy, true);

  result = releaseDoctor(releaseDoctorFacts({ npm: { known: true, exists: false } }));
  assert.equal(result.status, 1);
  payload = JSON.parse(result.stdout);
  assert.ok(payload.actions.some((action) => action.id === "publish-npm"));

  result = releaseDoctor(releaseDoctorFacts({ githubPackage: { known: true, exists: false } }));
  assert.equal(result.status, 1);
  payload = JSON.parse(result.stdout);
  assert.ok(payload.actions.some((action) => action.id === "publish-github"));

  result = releaseDoctor(releaseDoctorFacts({ githubRelease: { known: true, exists: false } }));
  assert.equal(result.status, 1);
  payload = JSON.parse(result.stdout);
  assert.ok(payload.actions.some((action) => action.id === "create-release"));
});

test("release doctor blocks mismatched or unknown release state", async () => {
  let result = releaseDoctor(releaseDoctorFacts({ taggedPackage: { known: true, version: "1.2.2" } }));
  assert.equal(result.status, 3);
  let payload = JSON.parse(result.stdout);
  assert.ok(payload.problems.some((problem) => problem.includes("tag v1.2.3 package version is 1.2.2")));

  result = releaseDoctor(releaseDoctorFacts({ npm: { known: false, reason: "registry timeout" } }));
  assert.equal(result.status, 2);
  payload = JSON.parse(result.stdout);
  assert.ok(payload.unknowns.some((unknown) => unknown.includes("registry timeout")));
});

test("auto-git snapshot derives PR readiness and records PR handoffs", async () => {
  const repo = await createFixtureRepo("auto-git-pr-ready-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-pr-ready-state-"));
  try {
    git(repo, ["switch", "-c", "codex/fix-ready"]);
    await writeProjectFile(repo, "src/app.js", "export const value = 'ready';\n");
    commit(repo, "fix(app): make branch ready", "Codex Tester <codex@example.com>");

    let result = snapshot(repo, ["--write-state", "--claim-run", "get this in", "--run-id", "ready-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.snapshot.prReadiness, "draft-pr");

    result = snapshot(
      repo,
      [
        "--write-state",
        "--record-verification",
        "pnpm verify",
        "--exit-code",
        "0",
        "--run-id",
        "ready-run"
      ],
      { AUTO_GIT_STATE_HOME: stateHome }
    );
    assert.equal(result.snapshot.prReadiness, "ready-pr");

    result = snapshot(
      repo,
      [
        "--write-state",
        "--record-pr",
        "ready-run",
        "--pr-url",
        "https://github.com/async/auto-git/pull/1",
        "--pr-number",
        "1"
      ],
      { AUTO_GIT_STATE_HOME: stateHome }
    );
    assert.equal(result.snapshot.prReadiness, "merge-candidate");
    assert.equal(result.snapshot.handoffs.openPrs[0].pr.url, "https://github.com/async/auto-git/pull/1");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git snapshot keeps experiments local and rejects secret-looking ledger values", async () => {
  const repo = await createFixtureRepo("auto-git-ledger-safety-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-ledger-safety-state-"));
  try {
    let result = snapshot(repo, ["--write-state", "--claim-run", "testing something", "--run-id", "experiment-run"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    assert.equal(result.snapshot.occupancy.activeRuns[0].intent, "experiment");
    assert.equal(result.snapshot.prReadiness, "none");
    assert.equal(result.snapshot.handoffs.openPrs.length, 0);

    result = spawnSync(
      process.execPath,
      [
        path.join(rootDir, "skills/auto-git/scripts/auto-git-snapshot.mjs"),
        "--cwd",
        repo,
        "--write-state",
        "--claim-run",
        "fix TOKEN=abc123"
      ],
      { encoding: "utf8", env: { ...process.env, AUTO_GIT_STATE_HOME: stateHome } }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret/i);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("auto-git gate records compact receipts and classifies environment failures", async () => {
  const repo = await createFixtureRepo("auto-git-gate-");
  const stateHome = await mkdtemp(path.join(tmpdir(), "auto-git-gate-state-"));
  try {
    let result = gate(
      repo,
      ["--quiet-seconds", "1", "--", process.execPath, "-e", "console.log('gate ok')"],
      { AUTO_GIT_STATE_HOME: stateHome }
    );
    assert.equal(result.status, 0, result.stderr);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.failureClass, "passed");
    assert.ok(payload.pid);
    assert.equal(payload.stdoutTail.at(-1), "gate ok");
    assert.equal(payload.stateWrite.process.ok, true);

    result = gate(
      repo,
      [
        "--quiet-seconds",
        "1",
        "--",
        process.execPath,
        "-e",
        "console.error('listen EPERM 127.0.0.1'); process.exit(1)"
      ],
      { AUTO_GIT_STATE_HOME: stateHome }
    );
    assert.equal(result.status, 1);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.failureClass, "environment-failure");
    assert.deepEqual(payload.envOverrides, {});
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createFixtureRepo(prefix) {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Codex Tester"]);
  git(repo, ["config", "user.email", "codex@example.com"]);
  await writeProjectFile(repo, "README.md", "hello\n");
  commit(repo, "chore(repo): initial fixture", "Codex Tester <codex@example.com>");
  return repo;
}

function snapshot(cwd, args = [], env = {}) {
  const script = path.join(rootDir, "skills/auto-git/scripts/auto-git-snapshot.mjs");
  const result = spawnSync(process.execPath, [script, "--cwd", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function gate(cwd, args = [], env = {}) {
  const script = path.join(rootDir, "skills/auto-git/scripts/auto-git-gate.mjs");
  return spawnSync(process.execPath, [script, "--cwd", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function script(scriptName, cwd, args = [], env = {}) {
  const scriptPath = path.join(rootDir, "skills/auto-git/scripts", scriptName);
  return spawnSync(process.execPath, [scriptPath, "--cwd", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function releaseDoctorFacts(overrides = {}) {
  return {
    package: { name: "@async/auto-git", version: "1.2.3", private: false },
    head: "abc123",
    tag: "v1.2.3",
    localTag: { known: true, exists: true, commit: "abc123" },
    remoteTag: { known: true, exists: true, commit: "abc123" },
    npm: { known: true, exists: true, version: "1.2.3" },
    githubPackage: { known: true, exists: true, version: "1.2.3" },
    githubRelease: { known: true, exists: true },
    workflow: { known: true, exists: true, latest: { conclusion: "success" } },
    taggedPackage: { known: true, version: "1.2.3" },
    ...overrides
  };
}

function releaseDoctor(facts) {
  return spawnSync(process.execPath, [path.join(rootDir, "scripts/release-doctor.mjs"), "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, AUTO_GIT_RELEASE_DOCTOR_FACTS: JSON.stringify(facts) }
  });
}

async function writeProjectFile(repo, filePath, content) {
  await mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
  await writeFile(path.join(repo, filePath), content);
}

function commit(repo, message, author) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--author", author, "-m", message]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
