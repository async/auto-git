#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-ledger.mjs <list|show|stale|handoffs> [run-id] [--cwd <repo>] [--json]",
    "",
    "Reads the cooperative Auto Git ledger without deleting or mutating entries."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { cwd: process.cwd(), command: undefined, runId: undefined, json: false };
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
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (!parsed.command) {
      parsed.command = arg;
      continue;
    }
    if (!parsed.runId) {
      parsed.runId = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  parsed.command = parsed.command ?? "list";
  if (!["list", "show", "stale", "handoffs"].includes(parsed.command)) {
    throw new Error("command must be one of list, show, stale, or handoffs.");
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function sha256(value, length = 64) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
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

function runSnapshot(cwd) {
  const result = spawnSync(process.execPath, [SNAPSHOT_SCRIPT.pathname, "--cwd", cwd], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `snapshot exited ${result.status}`);
  const payload = JSON.parse(result.stdout);
  if (!payload.ok) throw new Error(payload.error ?? "snapshot failed");
  return payload.snapshot;
}

function publicRun(run, statusById) {
  return {
    id: run.id,
    taskSlug: run.taskSlug,
    intent: run.intent,
    lifecycle: run.lifecycle,
    status: statusById.get(run.id) ?? run.status ?? "active",
    branch: run.branch,
    worktreePath: run.worktreePath,
    baseBranch: run.baseBranch,
    claimedAt: run.claimedAt,
    leasePath: run.leasePath,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
    completedAt: run.completedAt,
    head: run.head,
    commits: Array.isArray(run.commits) ? run.commits : [],
    verification: run.verification
      ? {
          name: run.verification.name,
          exitCode: run.verification.exitCode,
          failureClass: run.verification.failureClass,
          head: run.verification.head,
          recordedAt: run.verification.recordedAt
        }
      : undefined,
    pr: run.pr,
    decisionReceipt: run.decisionReceipt
  };
}

function buildReceipt(options) {
  const cwd = resolve(options.cwd);
  const snapshot = runSnapshot(cwd);
  const repoDir = join(stateRoot(), "repos", snapshot.repo.hash || sha256(snapshot.repo.root, 24));
  const ledger = readJson(join(repoDir, "ledger.json"), { schemaVersion: 3, runs: [] });
  const statusById = new Map();
  for (const run of snapshot.occupancy?.activeRuns ?? []) statusById.set(run.id, run.status);
  for (const run of snapshot.occupancy?.staleRuns ?? []) statusById.set(run.id, run.status);
  const runs = (Array.isArray(ledger.runs) ? ledger.runs : []).map((run) => publicRun(run, statusById));
  const handoffs = runs.filter((run) => run.pr && ["open", "draft"].includes(run.pr.status ?? "open"));
  const staleRuns = runs.filter((run) => run.status === "stale" || run.status === "abandoned-candidate");

  let selectedRuns = runs;
  if (options.command === "show") {
    if (!options.runId) throw new Error("show requires a run id.");
    selectedRuns = runs.filter((run) => run.id === options.runId);
  } else if (options.command === "stale") {
    selectedRuns = staleRuns;
  } else if (options.command === "handoffs") {
    selectedRuns = handoffs;
  }

  return {
    schemaVersion: 1,
    tool: "auto-git-ledger",
    ok: true,
    command: options.command,
    repo: {
      root: snapshot.repo.root,
      hash: snapshot.repo.hash,
      branch: snapshot.topology.branch
    },
    ledger: {
      path: join(repoDir, "ledger.json"),
      exists: existsSync(join(repoDir, "ledger.json")),
      updatedAt: ledger.updatedAt,
      runCount: runs.length
    },
    occupancy: snapshot.occupancy,
    runs: selectedRuns,
    handoffs,
    staleRuns
  };
}

function printText(receipt) {
  console.log(`command: ${receipt.command}`);
  console.log(`repo: ${receipt.repo.root}`);
  console.log(`ledger: ${receipt.ledger.exists ? receipt.ledger.path : "missing"}`);
  if (receipt.runs.length === 0) {
    console.log("runs: none");
    return;
  }
  for (const run of receipt.runs) {
    const pr = run.pr?.url ? ` pr=${run.pr.url}` : "";
    const decision = run.decisionReceipt?.normalizedIntentLabel ? ` decision=${run.decisionReceipt.normalizedIntentLabel}` : "";
    console.log(`${run.id} status=${run.status} lifecycle=${run.lifecycle} intent=${run.intent}${decision} branch=${run.branch ?? "none"}${pr}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const receipt = buildReceipt(options);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else printText(receipt);
} catch (error) {
  const payload = { schemaVersion: 1, tool: "auto-git-ledger", ok: false, error: String(error?.message ?? error) };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
