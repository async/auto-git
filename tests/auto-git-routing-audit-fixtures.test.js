import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const rootDir = new URL("..", import.meta.url).pathname;
const fixturePath = path.join(rootDir, "tests/fixtures/auto-git-routing-audit/cases.json");

const canonicalTasks = {
  "installed-vs-source-auto-git-testing": "review Auto Git installed source testing boundary",
  "release-thread-handoff": "create a follow-up chat after ADR 4",
  "package-path-scope-correction": "scope correction target package auto git state",
  "sync-with-main": "sync with main",
  "everything-plus-release-merge": "everything release",
  "coordinated-local-only-evidence": "get this in",
  "inconclusive-no-decision-point": "please look at this when you have a chance"
};

const unsafeFixturePatterns = [
  /<codex_delegation>/i,
  /\b(?:assistant|user|system):/i,
  /\b(?:BEGIN|END) TRANSCRIPT\b/i,
  /\bfull transcript\b/i,
  /\braw diff\b/i,
  /\bcommand output\b/i,
  /\benvironment value\b/i,
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|_authToken|ACCESS_KEY|PRIVATE_KEY)\s*[=:]/i,
  /\/Users\/[^/\s"]+/i
];

test("routing audit fixtures stay sanitized and complete", async () => {
  const fixture = await readRoutingAuditFixture();
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.source, "ADR 4 sanitized routing audit categories");
  assert.ok(fixture.cases.length >= 7);

  const raw = JSON.stringify(fixture);
  for (const pattern of unsafeFixturePatterns) {
    assert.doesNotMatch(raw, pattern);
  }

  const requiredFields = [
    "id",
    "triggerType",
    "expectedRoute",
    "observedRouteCategory",
    "followUpEvidenceClass",
    "verdict",
    "sanitizedRationaleClass",
    "evidenceFlags",
    "expectedReceipt"
  ];
  const requiredEvidenceFlags = [
    "startReceipt",
    "finishGate",
    "ledgerThread",
    "verification",
    "push",
    "prOrMerge",
    "releasePreflight",
    "localOnly",
    "decisionPointReached"
  ];

  for (const item of fixture.cases) {
    for (const field of requiredFields) {
      assert.ok(Object.hasOwn(item, field), `${item.id} has ${field}`);
    }
    for (const flag of requiredEvidenceFlags) {
      assert.equal(typeof item.evidenceFlags[flag], "boolean", `${item.id} has boolean ${flag}`);
    }
    assert.ok(canonicalTasks[item.triggerType], `${item.id} has a synthetic task mapping`);
    assert.ok(["correct", "misroute", "inconclusive"].includes(item.verdict), `${item.id} has a supported verdict`);
    assert.ok(item.expectedReceipt.completionGates.length > 0, `${item.id} has receipt gates`);

    if (item.verdict === "inconclusive") {
      assert.equal(item.evidenceFlags.decisionPointReached, false, `${item.id} does not force an audit verdict`);
      assert.equal(item.expectedReceipt.normalizedIntentLabel, "inconclusive", `${item.id} keeps routing inconclusive`);
      assert.ok(item.expectedReceipt.completionGates.includes("manual-routing-confirmation"));
    }
  }
});

test("start decision receipts match sanitized routing audit fixtures", async () => {
  const fixture = await readRoutingAuditFixture();

  for (const item of fixture.cases) {
    const repo = await createFixtureRepo(`auto-git-routing-${item.id}-`);
    const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-routing-state-${item.id}-`));
    try {
      const result = script("auto-git-start.mjs", repo, ["--task", canonicalTasks[item.triggerType], "--run-id", item.id, "--json"], {
        AUTO_GIT_STATE_HOME: stateHome
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const payload = JSON.parse(result.stdout);
      const receipt = payload.decisionReceipt;
      assert.equal(receipt.normalizedIntentLabel, item.expectedReceipt.normalizedIntentLabel, item.id);
      assert.equal(receipt.selectedWorkflowMode, item.expectedReceipt.selectedWorkflowMode, item.id);
      assert.equal(receipt.releasePreflightRequired, item.expectedReceipt.releasePreflightRequired, item.id);
      assert.equal(receipt.threadHandoffRequired, item.expectedReceipt.threadHandoffRequired, item.id);
      assert.deepEqual(receipt.completionGates, item.expectedReceipt.completionGates, item.id);
      assert.equal(Object.hasOwn(receipt, "task"), false);
      assert.equal(Object.hasOwn(payload, "task"), false);

      if (item.expectedRoute === "meta-testing") {
        assert.equal(receipt.selectedWorkflowMode, "local-review");
        assert.ok(receipt.completionGates.includes("manual-routing-confirmation"));
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  }
});

test("finish gates replay sanitized audit evidence classes", async () => {
  const fixture = await readRoutingAuditFixture();

  for (const item of fixture.cases.filter((entry) => entry.finishScenario)) {
    const result = await runFinishScenario(item);
    assert.equal(result.status, 1, `${item.id} should be blocked`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked", item.id);

    for (const blocker of item.expectedFinishBlockers) {
      assert.ok(payload.blockers.some((entry) => entry.includes(blocker)), `${item.id} includes ${blocker}`);
    }

    if (item.finishScenario === "coordinated-local-only") {
      assert.equal(payload.handoffCheck.satisfied, false);
      assert.equal(payload.contract.push.satisfied, false);
      assert.equal(payload.verificationMatchesCurrentHead, false);
    }

    if (item.finishScenario === "release-without-preflight") {
      assert.equal(payload.contract.releasePreflight.required, true);
      assert.equal(payload.contract.releasePreflight.satisfied, false);
    }

    if (item.finishScenario === "inconclusive") {
      assert.equal(item.verdict, "inconclusive");
      assert.equal(payload.contract.manualRouting.required, true);
      assert.equal(payload.contract.manualRouting.satisfied, false);
    }
  }
});

async function readRoutingAuditFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

async function runFinishScenario(item) {
  if (item.finishScenario === "coordinated-local-only") return runCoordinatedLocalOnly(item);
  if (item.finishScenario === "release-without-preflight") return runReleaseWithoutPreflight(item);
  if (item.finishScenario === "missing-thread-evidence") return runMissingThreadEvidence(item);
  if (item.finishScenario === "inconclusive") return runInconclusiveFinish(item);
  throw new Error(`Unsupported finish scenario: ${item.finishScenario}`);
}

async function runCoordinatedLocalOnly(item) {
  const repo = await createFixtureRepo(`auto-git-${item.id}-`);
  const remote = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-remote-`));
  const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-state-`));
  try {
    git(remote, ["init", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["switch", "-c", "codex/local-only"]);

    snapshot(repo, ["--write-state", "--claim-run", canonicalTasks[item.triggerType], "--run-id", item.id], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    await writeProjectFile(repo, "src/local-only.js", "export const localOnly = true;\n");
    commit(repo, "feat(auto-git): create local-only branch evidence", "Codex Tester <codex@example.com>");
    snapshot(repo, ["--write-state", "--heartbeat-run", item.id], { AUTO_GIT_STATE_HOME: stateHome });

    return script("auto-git-finish.mjs", repo, ["--run-id", item.id, "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
}

async function runReleaseWithoutPreflight(item) {
  const repo = await createFixtureRepo(`auto-git-${item.id}-`);
  const remote = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-remote-`));
  const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-state-`));
  try {
    git(remote, ["init", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    await writeProjectFile(
      repo,
      "package.json",
      JSON.stringify({ name: "fixture", version: "1.2.3", type: "module" }, null, 2) + "\n"
    );
    await writeProjectFile(repo, "CHANGELOG.md", "# Changelog\n\n## 1.2.3 - 2026-06-20\n\n- Release metadata.\n");
    commit(repo, "release(fixture): prepare 1.2.3", "Codex Tester <codex@example.com>");
    git(repo, ["push", "-u", "origin", "main"]);

    snapshot(repo, ["--write-state", "--claim-run", canonicalTasks[item.triggerType], "--run-id", item.id], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    snapshot(repo, ["--write-state", "--record-verification", "pnpm run verify", "--exit-code", "0", "--run-id", item.id], {
      AUTO_GIT_STATE_HOME: stateHome
    });

    return script("auto-git-finish.mjs", repo, ["--run-id", item.id, "--defer-release", "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
}

async function runMissingThreadEvidence(item) {
  const repo = await createFixtureRepo(`auto-git-${item.id}-`);
  const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-state-`));
  try {
    snapshot(repo, ["--write-state", "--claim-run", canonicalTasks[item.triggerType], "--run-id", item.id], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    return script("auto-git-finish.mjs", repo, ["--run-id", item.id, "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
}

async function runInconclusiveFinish(item) {
  const repo = await createFixtureRepo(`auto-git-${item.id}-`);
  const stateHome = await mkdtemp(path.join(tmpdir(), `auto-git-${item.id}-state-`));
  try {
    snapshot(repo, ["--write-state", "--claim-run", canonicalTasks[item.triggerType], "--run-id", item.id], {
      AUTO_GIT_STATE_HOME: stateHome
    });
    return script("auto-git-finish.mjs", repo, ["--run-id", item.id, "--complete", "--json"], {
      AUTO_GIT_STATE_HOME: stateHome
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
}

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

async function writeProjectFile(repo, relativePath, content) {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function commit(repo, message, author) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--author", author, "-m", message]);
}

function snapshot(cwd, args = [], env = {}) {
  const result = script("auto-git-snapshot.mjs", cwd, args, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function script(scriptName, cwd, args = [], env = {}) {
  const scriptPath = path.join(rootDir, "skills/auto-git/scripts", scriptName);
  return spawnSync(process.execPath, [scriptPath, "--cwd", cwd, ...args], {
    encoding: "utf8",
    env: testEnv(env)
  });
}

function testEnv(env = {}) {
  const merged = { ...process.env, ...env };
  if (!Object.hasOwn(env, "AUTO_GIT_LOCK_HOME")) {
    merged.AUTO_GIT_LOCK_HOME = path.join(tmpdir(), "auto-git-test-locks");
  }
  return merged;
}
