#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-finish.mjs [--cwd <repo>] [--run-id <id>] [--complete]",
    "       [--record-pr <url> [--pr-number <n>] [--pr-status <open|draft|closed|merged>]]",
    "       [--allow-dirty] [--json]",
    "",
    "Inspects final Auto Git state, optionally records a PR, and completes the run when safe."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    runId: undefined,
    complete: false,
    recordPr: undefined,
    prNumber: undefined,
    prStatus: "open",
    allowDirty: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--cwd") {
      parsed.cwd = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--complete") {
      parsed.complete = true;
      continue;
    }
    if (arg === "--record-pr") {
      parsed.recordPr = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--pr-number") {
      parsed.prNumber = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--pr-status") {
      parsed.prStatus = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function runSnapshot(args) {
  const result = spawnSync(process.execPath, [SNAPSHOT_SCRIPT.pathname, ...args], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `snapshot exited ${result.status}`);
  const payload = JSON.parse(result.stdout);
  if (!payload.ok) throw new Error(payload.error ?? "snapshot failed");
  return payload;
}

function currentRun(snapshot, requestedId) {
  const runs = [
    ...(snapshot.occupancy?.activeRuns ?? []),
    ...(snapshot.occupancy?.staleRuns ?? []),
    ...(snapshot.handoffs?.openPrs ?? [])
  ];
  if (requestedId) return runs.find((run) => run.id === requestedId);
  const active = snapshot.occupancy?.activeRuns ?? [];
  if (active.length === 1) return active[0];
  return runs.find((run) => run.branch === snapshot.topology.branch);
}

function verificationMatches(snapshot, run) {
  return Boolean(
    run?.verification?.exitCode === 0 &&
      run.verification.head === snapshot.topology.head &&
      run.verification.dirtyFingerprint === snapshot.dirty.fingerprint
  );
}

function activeLockPaths(snapshot) {
  const locks = [];
  if (snapshot.locks?.asyncRun?.status === "active") locks.push(snapshot.locks.asyncRun.path ?? ".async/run.lock");
  for (const lock of snapshot.locks?.asyncRunLocks ?? []) {
    if (lock.status === "active") locks.push(lock.path);
  }
  return locks;
}

function blockers(snapshot, run, options) {
  const issues = [];
  if (!run) issues.push("no Auto Git run could be resolved; pass --run-id");
  if (snapshot.dirty.isDirty && !options.allowDirty) issues.push("worktree has uncommitted changes");
  const lockPaths = activeLockPaths(snapshot);
  if (lockPaths.length > 0) issues.push(`active Async run locks remain: ${lockPaths.join(", ")}`);
  if (snapshot.workflowMode === "coordinated-branch" && ["merge", "branch"].includes(run?.intent)) {
    if (!verificationMatches(snapshot, run)) {
      issues.push("coordinated branch run lacks passing verification for current HEAD");
    }
  }
  return issues;
}

function inspect(cwd, runId) {
  const args = ["--cwd", cwd];
  if (runId) args.push("--run-id", runId);
  return runSnapshot(args).snapshot;
}

function buildReceipt(options) {
  const cwd = resolve(options.cwd);
  let snapshot = inspect(cwd, options.runId);
  let run = currentRun(snapshot, options.runId);
  const runId = options.runId ?? run?.id;
  const mutations = [];

  if (options.recordPr) {
    if (!runId) throw new Error("--record-pr requires --run-id when no active run is uniquely resolvable.");
    const args = ["--cwd", cwd, "--write-state", "--record-pr", runId, "--pr-url", options.recordPr, "--pr-status", options.prStatus];
    if (options.prNumber) args.push("--pr-number", options.prNumber);
    runSnapshot(args);
    mutations.push("record-pr");
    snapshot = inspect(cwd, runId);
    run = currentRun(snapshot, runId);
  }

  const issues = blockers(snapshot, run, options);
  let completed = false;
  if (options.complete && issues.length === 0) {
    if (!runId) throw new Error("--complete requires --run-id when no active run is uniquely resolvable.");
    runSnapshot(["--cwd", cwd, "--write-state", "--complete-run", runId]);
    mutations.push("complete-run");
    completed = true;
    snapshot = inspect(cwd, runId);
  }

  return {
    schemaVersion: 1,
    tool: "auto-git-finish",
    ok: issues.length === 0,
    status: issues.length === 0 ? (completed ? "completed" : "ready") : "blocked",
    completed,
    mutations,
    blockers: issues,
    repo: {
      root: snapshot.repo.root,
      branch: snapshot.topology.branch,
      head: snapshot.topology.head,
      upstream: snapshot.topology.upstream,
      ahead: snapshot.topology.ahead,
      behind: snapshot.topology.behind
    },
    runId,
    workflowMode: snapshot.workflowMode,
    recommendedAction: snapshot.recommendedAction,
    prReadiness: snapshot.prReadiness,
    dirty: {
      isDirty: snapshot.dirty.isDirty,
      staged: snapshot.dirty.stagedNameStatus,
      untracked: snapshot.dirty.untracked
    },
    locks: {
      activeAsyncRunLocks: activeLockPaths(snapshot)
    },
    verificationMatchesCurrentHead: verificationMatches(snapshot, run),
    pr: run?.pr
  };
}

function printText(receipt) {
  console.log(`status: ${receipt.status}`);
  console.log(`runId: ${receipt.runId ?? "none"}`);
  console.log(`workflowMode: ${receipt.workflowMode}`);
  console.log(`recommendedAction: ${receipt.recommendedAction}`);
  if (receipt.blockers.length > 0) {
    console.log("blockers:");
    for (const blocker of receipt.blockers) console.log(`- ${blocker}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const receipt = buildReceipt(options);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else printText(receipt);
  if (!receipt.ok) process.exit(1);
} catch (error) {
  const payload = { schemaVersion: 1, tool: "auto-git-finish", ok: false, error: String(error?.message ?? error) };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
