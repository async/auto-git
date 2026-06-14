#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-start.mjs [--cwd <repo>] [--task <text>] [--run-id <id>]",
    "       [--intent <name>] [--lifecycle <checkpoint|sync|land|fanout|everything>]",
    "       [--lease-ttl-ms <n>] [--json]",
    "",
    "Claims an Auto Git run and prints the selected workflow plus next action."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    task: undefined,
    runId: undefined,
    intent: undefined,
    lifecycle: undefined,
    leaseTtlMs: undefined,
    json: false,
    taskParts: []
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
    if (arg === "--task") {
      parsed.task = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--intent") {
      parsed.intent = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--lifecycle") {
      parsed.lifecycle = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--lease-ttl-ms") {
      parsed.leaseTtlMs = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    parsed.taskParts.push(arg);
  }

  parsed.task = (parsed.task ?? parsed.taskParts.join(" ").trim()) || "auto git run";
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function runSnapshot(args, env = process.env) {
  const result = spawnSync(process.execPath, [SNAPSHOT_SCRIPT.pathname, ...args], {
    encoding: "utf8",
    env
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `snapshot exited ${result.status}`);
  }
  const payload = JSON.parse(result.stdout);
  if (!payload.ok) throw new Error(payload.error ?? "snapshot failed");
  return payload;
}

function findRun(snapshot, runId) {
  const runs = [
    ...(snapshot.occupancy?.activeRuns ?? []),
    ...(snapshot.occupancy?.staleRuns ?? []),
    ...(snapshot.handoffs?.openPrs ?? [])
  ];
  return runs.find((run) => run.id === runId) ?? runs.find((run) => run.branch === snapshot.topology.branch);
}

function worktreeSuggestion(snapshot, run) {
  if (!run || snapshot.workflowMode !== "coordinated-branch") return undefined;
  const shortId = String(run.id).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8) || "run";
  const slug = run.taskSlug || "auto-git";
  const branch = run.branch && run.branch !== snapshot.topology.branch ? run.branch : `codex/${slug}-${shortId}`;
  const path = `../${snapshot.repo.slug}-${slug}`;
  return {
    branch,
    path,
    command: ["git", "worktree", "add", path, "-b", branch, run.baseBranch ?? snapshot.topology.branch ?? "HEAD"]
  };
}

function nextSteps(snapshot, run) {
  const steps = [];
  if (snapshot.workflowMode === "local-review") {
    steps.push("Stay in the current checkout and commit by change intent.");
    steps.push("Do not create a PR unless the user asks for publish, PR, get-this-in, or ship behavior.");
  } else {
    steps.push("Use an isolated branch/worktree unless already in the right one.");
    steps.push("Record verification and PR handoff metadata before finishing.");
  }
  if (run?.lifecycle === "everything") {
    steps.push("Everything mode: manage commits by feature, verification, sync, merge, and release when the request clearly authorizes each step.");
  }
  if (snapshot.prReadiness && snapshot.prReadiness !== "none") {
    steps.push(`Current PR readiness: ${snapshot.prReadiness}.`);
  }
  return steps;
}

function buildReceipt(payload, options) {
  const snapshot = payload.snapshot;
  const runId = snapshot.ledger?.currentRunId;
  const run = findRun(snapshot, runId);
  return {
    schemaVersion: 1,
    tool: "auto-git-start",
    ok: true,
    repo: {
      root: snapshot.repo.root,
      hash: snapshot.repo.hash,
      branch: snapshot.topology.branch,
      baseBranch: run?.baseBranch
    },
    runId,
    workflowMode: snapshot.workflowMode,
    lifecycle: run?.lifecycle,
    intent: run?.intent,
    occupancy: {
      status: snapshot.occupancy?.status,
      activeRunIds: (snapshot.occupancy?.activeRuns ?? []).map((entry) => entry.id),
      staleRunIds: (snapshot.occupancy?.staleRuns ?? []).map((entry) => entry.id)
    },
    recommendedAction: snapshot.recommendedAction,
    prReadiness: snapshot.prReadiness,
    worktreeSuggestion: worktreeSuggestion(snapshot, run),
    nextSteps: nextSteps(snapshot, run),
    stateWrite: payload.stateWrite,
    task: options.task
  };
}

function printText(receipt) {
  console.log(`workflowMode: ${receipt.workflowMode}`);
  console.log(`lifecycle: ${receipt.lifecycle ?? "unknown"}`);
  console.log(`intent: ${receipt.intent ?? "unknown"}`);
  console.log(`runId: ${receipt.runId ?? "none"}`);
  console.log(`occupancy: ${receipt.occupancy.status}`);
  console.log(`recommendedAction: ${receipt.recommendedAction}`);
  if (receipt.worktreeSuggestion) {
    console.log(`suggestedBranch: ${receipt.worktreeSuggestion.branch}`);
    console.log(`suggestedWorktree: ${receipt.worktreeSuggestion.path}`);
    console.log(`suggestedCommand: ${receipt.worktreeSuggestion.command.join(" ")}`);
  }
  for (const step of receipt.nextSteps) console.log(`- ${step}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const args = ["--cwd", resolve(options.cwd), "--write-state", "--claim-run", options.task];
  if (options.runId) args.push("--run-id", options.runId);
  if (options.intent) args.push("--intent", options.intent);
  if (options.lifecycle) args.push("--lifecycle", options.lifecycle);
  if (options.leaseTtlMs) args.push("--lease-ttl-ms", options.leaseTtlMs);
  const receipt = buildReceipt(runSnapshot(args), options);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else printText(receipt);
} catch (error) {
  const payload = { schemaVersion: 1, tool: "auto-git-start", ok: false, error: String(error?.message ?? error) };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
