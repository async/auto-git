#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-finish.mjs [--cwd <repo>] [--run-id <id>] [--complete]",
    "       [--record-pr <url> [--pr-number <n>] [--pr-status <open|draft|closed|merged>]]",
    "       [--defer-release] [--allow-dirty] [--json]",
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
    deferRelease: false,
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
    if (arg === "--defer-release") {
      parsed.deferRelease = true;
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

function decisionReceipt(run) {
  return run?.decisionReceipt;
}

function decisionGates(run) {
  return new Set(decisionReceipt(run)?.completionGates ?? []);
}

function hasGate(run, gate) {
  return decisionGates(run).has(gate);
}

function decisionIntent(run) {
  return decisionReceipt(run)?.normalizedIntentLabel;
}

function decisionWorkflow(run) {
  return decisionReceipt(run)?.selectedWorkflowMode;
}

function requiresVerification(run) {
  return hasGate(run, "verification") || ["sync", "release", "land", "everything", "yolo"].includes(decisionIntent(run));
}

function requiresPushEvidence(run) {
  return (
    hasGate(run, "branch-pushed") ||
    hasGate(run, "branch-pushed-before-tag") ||
    ["sync", "release", "PR", "merge", "land", "everything", "yolo"].includes(decisionIntent(run))
  );
}

function requiresBranchOrWorktreeEvidence(run) {
  return (
    hasGate(run, "isolated-branch-or-worktree") ||
    hasGate(run, "isolated-worktrees") ||
    decisionWorkflow(run) === "coordinated-branch-worktree"
  );
}

function requiresHandoffEvidence(run) {
  return hasGate(run, "pr-handoff-or-merge-evidence") || ["PR", "merge", "land", "everything", "yolo"].includes(decisionIntent(run));
}

function requiresReleasePreflight(run) {
  return (
    decisionReceipt(run)?.releasePreflightRequired === true ||
    hasGate(run, "release-preflight") ||
    hasGate(run, "release-preflight-before-release-action") ||
    ["release", "yolo"].includes(decisionIntent(run)) ||
    run?.intent === "release" ||
    run?.lifecycle === "yolo"
  );
}

function requiresReleaseCompletion(run) {
  return ["release", "yolo"].includes(decisionIntent(run)) || run?.intent === "release" || run?.lifecycle === "yolo";
}

function requiresThreadHandoff(run) {
  return decisionReceipt(run)?.threadHandoffRequired === true || hasGate(run, "thread-handoff-evidence");
}

function requiresReturnToBase(run) {
  return hasGate(run, "return-to-base") || hasGate(run, "handoff-or-return-to-base") || requiresBranchOrWorktreeEvidence(run);
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
  const required = Boolean(requiresHandoffEvidence(run));
  return {
    required,
    satisfied: !required || pr.handoffRecorded || merge.mergedIntoBase,
    pr,
    merge
  };
}

function branchPushState(cwd, branch) {
  const result = {
    branch,
    required: Boolean(branch),
    upstream: undefined,
    aheadOfUpstream: undefined,
    behindUpstream: undefined,
    pushed: false,
    blockers: []
  };
  if (!branch) {
    result.blockers.push("missing branch name for push check");
    return result;
  }
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    result.blockers.push(`branch ${branch} has no upstream`);
    return result;
  }
  result.upstream = upstream.stdout.trim();
  const counts = git(cwd, ["rev-list", "--left-right", "--count", `${result.upstream}...${branch}`]);
  if (counts.status !== 0) {
    result.blockers.push(`could not compare ${branch} with ${result.upstream}`);
    return result;
  }
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
  return result;
}

function pushCheck(snapshot, run, cwd, completion, merge) {
  const required = requiresPushEvidence(run);
  const branch = completion.branch ?? run?.branch ?? snapshot.topology.branch;
  if (!required) return { required, satisfied: true, branch, pushed: true, blockers: [] };
  if (merge?.mergedIntoBase) {
    return {
      required,
      satisfied: merge.basePushed,
      branch: merge.baseBranch,
      pushed: merge.basePushed,
      upstream: merge.baseUpstream,
      blockers: merge.basePushed ? [] : merge.blockers
    };
  }
  if (completion.required) {
    return {
      required,
      satisfied: completion.pushed,
      branch: completion.branch,
      pushed: completion.pushed,
      upstream: completion.upstream,
      blockers: completion.blockers.filter((blocker) => !blocker.startsWith("checkout is still on "))
    };
  }
  const state = branchPushState(cwd, branch);
  return {
    required,
    satisfied: state.pushed,
    ...state
  };
}

function hasUnresolvedIndex(snapshot) {
  return (snapshot.dirty?.statusPorcelain ?? []).some((line) => /^(DD|AU|UD|UA|DU|AA|UU)\s/.test(line));
}

function commitEvidence(snapshot, run, cwd) {
  const baseBranch = defaultBaseBranch(snapshot, run);
  const currentBranch = snapshot.topology.branch || "HEAD";
  const recordedCommits = Array.isArray(run?.commits) ? run.commits : [];
  const ahead = baseBranch && currentBranch !== baseBranch ? git(cwd, ["rev-list", "--reverse", `${baseBranch}..${currentBranch}`]) : undefined;
  const currentAheadCommits = ahead?.status === 0 ? ahead.stdout.trim().split("\n").filter(Boolean) : [];
  const headChanged = Boolean(run?.head && snapshot.topology.head && run.head !== snapshot.topology.head);
  const changesMade = recordedCommits.length > 0 || currentAheadCommits.length > 0 || headChanged;
  return {
    required: hasGate(run, "commit-by-intent") || hasGate(run, "commit-by-intent-per-worktree") || hasGate(run, "release-metadata-commit"),
    changesMade,
    recorded: recordedCommits.length > 0 || (!changesMade && Boolean(run?.head)),
    recordedCommits,
    currentAheadCommitCount: currentAheadCommits.length,
    headChanged
  };
}

function branchOrWorktreeCheck(snapshot, run, completion) {
  const required = requiresBranchOrWorktreeEvidence(run);
  const baseBranch = defaultBaseBranch(snapshot, run);
  const branch = run?.branch ?? completion.branch;
  const branchIsIsolated = Boolean(branch && branch !== baseBranch);
  const worktreeExists = Boolean(run?.worktreePath && existsSync(run.worktreePath));
  return {
    required,
    satisfied: !required || (branchIsIsolated && worktreeExists),
    branch,
    baseBranch,
    worktreePath: run?.worktreePath,
    worktreeExists
  };
}

function releasePreflightCheck(snapshot, run) {
  const required = requiresReleasePreflight(run);
  const evidence = run?.releasePreflight;
  const headMatches = Boolean(
    evidence?.head && (evidence.head === run?.head || evidence.head === snapshot.topology.head)
  );
  const cleanEnough = !snapshot.dirty?.isDirty || evidence?.dirtyFingerprint === snapshot.dirty.fingerprint || evidence?.dirtyFingerprint === run?.dirtyFingerprint;
  return {
    required,
    satisfied: !required || Boolean(evidence?.safeToTag === true && headMatches && cleanEnough),
    evidence: evidence
      ? {
          safeToTag: evidence.safeToTag,
          version: evidence.version,
          tagName: evidence.tagName,
          recordedAt: evidence.recordedAt,
          head: evidence.head
        }
      : undefined
  };
}

function releaseCompletionCheck(run) {
  const required = requiresReleaseCompletion(run);
  const executed = run?.releaseExecution?.status === "executed";
  const deferred = run?.releaseDeferral?.status === "deferred";
  return {
    required,
    satisfied: !required || executed || deferred,
    executed,
    deferred,
    deferral: run?.releaseDeferral
  };
}

function threadHandoffCheck(run) {
  const required = requiresThreadHandoff(run);
  const recorded = Boolean(run?.threadHandoff?.threadId || run?.threadHandoff?.status === "recorded");
  return {
    required,
    satisfied: !required || recorded,
    handoff: run?.threadHandoff
  };
}

function manualRoutingCheck(run) {
  const required = hasGate(run, "manual-routing-confirmation");
  return {
    required,
    satisfied: !required
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

function blockers(snapshot, run, options, completion, handoff, contract) {
  const issues = [];
  if (!run) issues.push("no Auto Git run could be resolved; pass --run-id");
  if (run && !decisionReceipt(run)) issues.push("missing start decision receipt; rerun auto-git start before finish");
  if (snapshot.dirty.isDirty && !options.allowDirty) issues.push("worktree has uncommitted changes");
  if (hasUnresolvedIndex(snapshot)) issues.push("unresolved index state; resolve conflicts before finish");
  const lockPaths = activeLockPaths(snapshot);
  if (lockPaths.length > 0) issues.push(`active Async run locks remain: ${lockPaths.join(", ")}`);
  if (contract.manualRouting.required && !contract.manualRouting.satisfied) {
    issues.push("missing manual routing confirmation; rerun auto-git start with an explicit lifecycle");
  }
  if (contract.commit.required && contract.commit.changesMade && !contract.commit.recorded) {
    issues.push("missing commit evidence; record the final run state with auto-git snapshot --write-state before finish");
  }
  if (contract.branchOrWorktree.required && !contract.branchOrWorktree.satisfied) {
    issues.push("missing branch/worktree evidence; heartbeat the run from its isolated branch or worktree before finish");
  }
  if (requiresVerification(run) && !verificationMatches(snapshot, run)) {
    issues.push("missing verification evidence; run auto-git gate or record a passing verification for the final HEAD");
  }
  if (contract.push.required && !contract.push.satisfied) {
    issues.push("missing push/sync evidence; push the required branch or merged base before finish");
  }
  issues.push(...completionBlockers(completion, handoff));
  if (handoff?.required && !handoff.satisfied) {
    issues.push("missing PR/merge/land evidence; record a PR handoff or merge and push the base before finish");
  }
  if (handoff?.merge?.mergedIntoBase) {
    issues.push(...(handoff.merge.blockers ?? []));
  }
  if (requiresReturnToBase(run) && completion.required && !completion.returnedToBase) {
    issues.push(`missing return-to-base evidence; switch back to ${completion.baseBranch} before finish`);
  }
  if (contract.releasePreflight.required && !contract.releasePreflight.satisfied) {
    issues.push("missing release-preflight evidence; run auto-git release-preflight --require-verification before finish");
  }
  if (contract.releaseCompletion.required && !contract.releaseCompletion.satisfied) {
    issues.push("missing release execution or deferral evidence; execute release or pass --defer-release when explicitly deferred");
  }
  if (contract.threadHandoff.required && !contract.threadHandoff.satisfied) {
    issues.push("missing follow-up thread evidence; record the thread handoff before finish");
  }
  return [...new Set(issues)];
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

  if (options.deferRelease) {
    if (!runId) throw new Error("--defer-release requires --run-id when no active run is uniquely resolvable.");
    ensureStateWrite(runSnapshot(["--cwd", cwd, "--write-state", "--record-release-deferral", runId]), "record release deferral");
    mutations.push("record-release-deferral");
    snapshot = inspect(cwd, runId);
    run = currentRun(snapshot, runId);
  }

  const completion = branchCompletion(snapshot, run, cwd);
  const merge = mergeCheck(run, cwd, completion);
  const handoff = handoffCheck(run, merge, completion);
  const contract = {
    manualRouting: manualRoutingCheck(run),
    commit: commitEvidence(snapshot, run, cwd),
    branchOrWorktree: branchOrWorktreeCheck(snapshot, run, completion),
    push: pushCheck(snapshot, run, cwd, completion, merge),
    releasePreflight: releasePreflightCheck(snapshot, run),
    releaseCompletion: releaseCompletionCheck(run),
    threadHandoff: threadHandoffCheck(run)
  };
  const issues = blockers(snapshot, run, options, completion, handoff, contract);
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
    contract,
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
