#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-finish.mjs [--cwd <repo>] [--run-id <id>] [--complete]",
    "       [--record-pr <url> [--pr-number <n>] [--pr-status <open|draft|closed|merged>]]",
    "       [--allow-dirty] [--json]",
    "",
    "Inspects final Auto Git state, optionally records a PR, and completes the run when safe.",
    "Coordinated branch completion requires a pushed branch and a checkout returned to base."
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

function ensureStateWrite(payload, action) {
  if (!payload.stateWrite?.ok) {
    throw new Error(`${action} failed to update Auto Git ledger: ${payload.stateWrite?.reason ?? "unknown error"}`);
  }
}

function stateRoot() {
  return process.env.AUTO_GIT_STATE_HOME || join(homedir(), ".async", "auto-git", "v1");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
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
  return verificationMatchesRun(run) || verificationMatchesCurrentCheckout(snapshot, run);
}

function verificationMatchesRun(run) {
  return Boolean(
    run?.verification?.exitCode === 0 &&
      run.verification.head === run.head &&
      run.verification.dirtyFingerprint === run.dirtyFingerprint
  );
}

function verificationMatchesCurrentCheckout(snapshot, run) {
  return Boolean(
    run?.verification?.exitCode === 0 &&
      run.verification.head === snapshot.topology.head &&
      run.verification.dirtyFingerprint === snapshot.dirty.fingerprint
  );
}

function isCompletionLifecycle(run) {
  return run?.lifecycle === "everything" || run?.lifecycle === "yolo";
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function defaultBaseBranch(snapshot, run) {
  if (run?.baseBranch) return run.baseBranch;
  const remoteHead = snapshot.topology.defaultRemoteHead;
  if (remoteHead?.includes("/")) return remoteHead.split("/").slice(1).join("/");
  return remoteHead || "main";
}

function branchCompletion(snapshot, run, cwd) {
  const branch = run?.branch;
  const baseBranch = defaultBaseBranch(snapshot, run);
  const required = Boolean(
    branch &&
      baseBranch &&
      branch !== baseBranch &&
      (snapshot.workflowMode === "coordinated-branch" || isCompletionLifecycle(run))
  );
  const result = {
    required,
    branch,
    baseBranch,
    currentBranch: snapshot.topology.branch,
    returnedToBase: !required || snapshot.topology.branch === baseBranch,
    exists: undefined,
    upstream: undefined,
    aheadOfUpstream: undefined,
    behindUpstream: undefined,
    pushed: !required,
    blockers: []
  };
  if (!required) return result;

  const exists = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  result.exists = exists.status === 0;
  if (!result.exists) {
    result.blockers.push(`branch ${branch} does not exist locally`);
    return result;
  }

  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    result.blockers.push(`branch ${branch} has no upstream; push it before finishing`);
  } else {
    result.upstream = upstream.stdout.trim();
    const counts = git(cwd, ["rev-list", "--left-right", "--count", `${result.upstream}...${branch}`]);
    if (counts.status === 0) {
      const [behind, ahead] = counts.stdout
        .trim()
        .split(/\s+/)
        .map((value) => Number(value));
      result.behindUpstream = Number.isFinite(behind) ? behind : undefined;
      result.aheadOfUpstream = Number.isFinite(ahead) ? ahead : undefined;
      result.pushed = result.aheadOfUpstream === 0;
      if (result.aheadOfUpstream && result.aheadOfUpstream > 0) {
        result.blockers.push(`branch ${branch} has ${result.aheadOfUpstream} unpushed commit(s)`);
      }
    } else {
      result.blockers.push(`could not compare ${branch} with ${result.upstream}`);
    }
  }

  if (!result.returnedToBase) {
    result.blockers.push(`checkout is still on ${snapshot.topology.branch}; switch back to ${baseBranch} before finishing`);
  }

  return result;
}

function prHandoff(run) {
  const status = run?.pr?.status ?? (run?.pr?.url ? "open" : undefined);
  const handoffRecorded = Boolean(run?.pr?.url && ["open", "draft", "merged"].includes(status));
  return {
    required: false,
    handoffRecorded,
    url: run?.pr?.url,
    status,
    number: run?.pr?.number
  };
}

function mergeCheck(run, cwd, completion) {
  const baseBranch = completion.baseBranch;
  const target = run?.head;
  const required = completion.required;
  const result = {
    required,
    baseBranch,
    targetHead: target,
    mergedIntoBase: false,
    branchAheadOfBase: undefined,
    baseUpstream: undefined,
    baseAheadOfUpstream: undefined,
    baseBehindUpstream: undefined,
    basePushed: !required,
    blockers: []
  };
  if (!required || !target || !baseBranch) return result;

  const merged = git(cwd, ["merge-base", "--is-ancestor", target, baseBranch]);
  result.mergedIntoBase = merged.status === 0;

  if (completion.branch && completion.exists) {
    const ahead = git(cwd, ["rev-list", "--count", `${baseBranch}..${completion.branch}`]);
    if (ahead.status === 0) {
      const value = Number(ahead.stdout.trim());
      result.branchAheadOfBase = Number.isFinite(value) ? value : undefined;
    }
  }

  if (result.mergedIntoBase) {
    const upstream = git(cwd, ["rev-parse", "--abbrev-ref", `${baseBranch}@{upstream}`]);
    if (upstream.status !== 0 || !upstream.stdout.trim()) {
      result.blockers.push(`base branch ${baseBranch} has no upstream; push merged work before finishing`);
    } else {
      result.baseUpstream = upstream.stdout.trim();
      const counts = git(cwd, ["rev-list", "--left-right", "--count", `${result.baseUpstream}...${baseBranch}`]);
      if (counts.status === 0) {
        const [behind, ahead] = counts.stdout
          .trim()
          .split(/\s+/)
          .map((value) => Number(value));
        result.baseBehindUpstream = Number.isFinite(behind) ? behind : undefined;
        result.baseAheadOfUpstream = Number.isFinite(ahead) ? ahead : undefined;
        result.basePushed = result.baseAheadOfUpstream === 0;
        if (result.baseAheadOfUpstream && result.baseAheadOfUpstream > 0) {
          result.blockers.push(`base branch ${baseBranch} has ${result.baseAheadOfUpstream} unpushed commit(s) after merge`);
        }
      } else {
        result.blockers.push(`could not compare ${baseBranch} with ${result.baseUpstream}`);
      }
    }
  }

  return result;
}

function handoffCheck(run, merge, completion) {
  const pr = prHandoff(run);
  const required = Boolean(
    completion.required && (isCompletionLifecycle(run) || ["merge", "branch"].includes(run?.intent))
  );
  return {
    required,
    satisfied: !required || pr.handoffRecorded || merge.mergedIntoBase,
    pr,
    merge
  };
}

function ledgerStatus(snapshot, runId) {
  const ledgerPath = join(stateRoot(), "repos", snapshot.repo.hash, "ledger.json");
  const ledger = readJson(ledgerPath, { runs: [] });
  const run = Array.isArray(ledger.runs) ? ledger.runs.find((entry) => entry?.id === runId) : undefined;
  return {
    path: ledgerPath,
    exists: Boolean(run),
    status: run?.status,
    completedAt: run?.completedAt,
    updatedAt: ledger.updatedAt
  };
}

function activeLockPaths(snapshot) {
  const locks = [];
  if (snapshot.locks?.asyncRun?.status === "active") locks.push(snapshot.locks.asyncRun.path ?? ".async/run.lock");
  for (const lock of snapshot.locks?.asyncRunLocks ?? []) {
    if (lock.status === "active") locks.push(lock.path);
  }
  return locks;
}

function completionBlockers(completion, handoff) {
  const blockers = completion?.blockers ?? [];
  if (!handoff?.merge?.mergedIntoBase) return blockers;
  return blockers.filter((blocker) => blocker.startsWith("checkout is still on "));
}

function blockers(snapshot, run, options, completion, handoff) {
  const issues = [];
  if (!run) issues.push("no Auto Git run could be resolved; pass --run-id");
  if (snapshot.dirty.isDirty && !options.allowDirty) issues.push("worktree has uncommitted changes");
  const lockPaths = activeLockPaths(snapshot);
  if (lockPaths.length > 0) issues.push(`active Async run locks remain: ${lockPaths.join(", ")}`);
  if (
    snapshot.workflowMode === "coordinated-branch" &&
    (["merge", "branch"].includes(run?.intent) || isCompletionLifecycle(run))
  ) {
    if (!verificationMatches(snapshot, run)) {
      issues.push("coordinated branch run lacks passing verification for its final branch HEAD");
    }
  }
  issues.push(...completionBlockers(completion, handoff));
  if (handoff?.required && !handoff.satisfied) {
    issues.push("coordinated branch has no recorded PR handoff and is not merged into base");
  }
  if (handoff?.merge?.mergedIntoBase) {
    issues.push(...(handoff.merge.blockers ?? []));
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
    ensureStateWrite(runSnapshot(args), "record PR");
    mutations.push("record-pr");
    snapshot = inspect(cwd, runId);
    run = currentRun(snapshot, runId);
  }

  const completion = branchCompletion(snapshot, run, cwd);
  const merge = mergeCheck(run, cwd, completion);
  const handoff = handoffCheck(run, merge, completion);
  const issues = blockers(snapshot, run, options, completion, handoff);
  let completed = false;
  if (options.complete && issues.length === 0) {
    if (!runId) throw new Error("--complete requires --run-id when no active run is uniquely resolvable.");
    ensureStateWrite(runSnapshot(["--cwd", cwd, "--write-state", "--complete-run", runId]), "complete run");
    mutations.push("complete-run");
    completed = true;
    snapshot = inspect(cwd, runId);
  }
  const ledger = ledgerStatus(snapshot, runId);

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
    branchCompletion: completion,
    handoffCheck: handoff,
    ledger,
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
