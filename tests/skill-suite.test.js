import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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
    }
  }
});

test("companion skills use Auto Git as commit-style source", async () => {
  const audit = await readFile(path.join(rootDir, "skills/git-intent-audit/SKILL.md"), "utf8");
  const rewrite = await readFile(path.join(rootDir, "skills/git-history-rewrite/SKILL.md"), "utf8");
  assert.match(audit, /Auto Git's commit style as the source of truth/);
  assert.match(rewrite, /using Auto Git's commit-by-intent style/);
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

async function writeProjectFile(repo, filePath, content) {
  await mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
  await writeFile(path.join(repo, filePath), content);
}

function commit(repo, message, author) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--author", author, "-m", message]);
}
