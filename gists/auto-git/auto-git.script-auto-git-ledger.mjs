#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);
const THREAD_ACTIONS = ["create", "send", "read", "handoff"];
const RELEASE_CHECK_STATUSES = ["not-in-scope", "passed", "failed", "blocked", "deferred", "unknown"];

function usage() {
  return [
    "Usage: auto-git-ledger.mjs <list|show|stale|handoffs> [run-id] [--cwd <repo>] [--json]",
    "       auto-git-ledger.mjs record-thread --run-id <id> --action <create|send|read|handoff>",
    "         [--source-session <id>] [--thread-id <id>] [--target <label>]",
    "         [--repo <label>] [--package <label>] [--branch <name>]",
    "         [--worktree <path-or-label>] [--worktree-class <class>]",
    "         [--pr-url <url>] [--pr-number <n>] [--release-check <status>]",
    "         [--next-adr <label>] [--cwd <repo>] [--json]",
    "",
    "Reads the cooperative Auto Git ledger and records sanitized thread handoff metadata."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    command: undefined,
    runId: undefined,
    json: false,
    action: undefined,
    sourceSession: undefined,
    threadId: undefined,
    target: undefined,
    repoLabel: undefined,
    packageLabel: undefined,
    branch: undefined,
    worktree: undefined,
    worktreeClass: undefined,
    prUrl: undefined,
    prNumber: undefined,
    releaseCheck: undefined,
    nextAdr: undefined
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
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--action" || arg === "--thread-action") {
      parsed.action = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--source-session") {
      parsed.sourceSession = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--thread-id") {
      parsed.threadId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--target") {
      parsed.target = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--repo") {
      parsed.repoLabel = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--package") {
      parsed.packageLabel = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--branch") {
      parsed.branch = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--worktree") {
      parsed.worktree = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--worktree-class") {
      parsed.worktreeClass = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--pr-url") {
      parsed.prUrl = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--pr-number") {
      parsed.prNumber = Number(requireValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--release-check") {
      parsed.releaseCheck = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--next-adr") {
      parsed.nextAdr = requireValue(argv, ++index, arg);
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
  if (!["list", "show", "stale", "handoffs", "record-thread"].includes(parsed.command)) {
    throw new Error("command must be one of list, show, stale, handoffs, or record-thread.");
  }
  if (parsed.command === "record-thread") {
    if (!parsed.runId) throw new Error("record-thread requires --run-id <id>.");
    if (!THREAD_ACTIONS.includes(parsed.action)) {
      throw new Error("--action must be one of create, send, read, or handoff.");
    }
    if (parsed.releaseCheck !== undefined && !RELEASE_CHECK_STATUSES.includes(parsed.releaseCheck)) {
      throw new Error("--release-check must be one of not-in-scope, passed, failed, blocked, deferred, or unknown.");
    }
    if (parsed.prNumber !== undefined && !Number.isInteger(parsed.prNumber)) {
      throw new Error("--pr-number must be an integer.");
    }
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function nowIso() {
  const fixture = process.env.AUTO_GIT_NOW;
  if (fixture) {
    const parsed = new Date(fixture);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function looksSecretish(value) {
  return /(?:TOKEN|SECRET|PASSWORD|PASSWD|_authToken|ACCESS_KEY|PRIVATE_KEY)\s*[=:]/i.test(String(value ?? ""));
}

function looksTranscriptish(value) {
  const text = String(value ?? "");
  return /(?:BEGIN TRANSCRIPT|END TRANSCRIPT|<codex_delegation>|<conversation|raw transcript|full transcript|full prompt|assistant:|user:)/i.test(
    text
  );
}

function safeText(value, maxLength = 120) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || looksSecretish(text) || looksTranscriptish(text)) return undefined;
  return text.slice(0, maxLength);
}

function sanitizeRunId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeLabel(value, maxLength = 120) {
  const text = safeText(value, maxLength);
  if (!text) return undefined;
  if (isAbsolute(text)) return basename(text).slice(0, maxLength);
  return text;
}

function sanitizePrUrl(value) {
  const text = safeText(value, 300);
  if (!text) return undefined;
  if (/[?&](?:token|auth|secret|password|key)=/i.test(text)) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) return undefined;
  } catch {
    return undefined;
  }
  return text;
}

function worktreePathClass(snapshot, value, explicitClass) {
  const classLabel = safeLabel(explicitClass, 80);
  const raw = typeof value === "string" && value.trim() ? value.trim() : snapshot.repo.root;
  const base = safeLabel(basename(raw), 80);
  if (classLabel) return base ? { class: classLabel, basename: base } : { class: classLabel };
  if (raw.includes("/.codex/worktrees/")) return { class: "codex-worktree", basename: base };
  if (raw.includes("/_worktrees/")) return { class: "repo-worktree", basename: base };
  if (isAbsolute(raw)) return { class: "local-worktree", basename: base };
  if (raw.startsWith("../")) return { class: "relative-worktree", basename: base };
  return { class: "worktree", basename: base };
}

function sanitizeThreadHandoff(handoff) {
  if (!handoff || typeof handoff !== "object") return undefined;
  const action = THREAD_ACTIONS.includes(handoff.action) ? handoff.action : undefined;
  const threadId = safeText(handoff.threadId, 120);
  const status = safeText(handoff.status, 40);
  const prUrl = sanitizePrUrl(handoff.pr?.url);
  const prNumber = Number.isInteger(Number(handoff.pr?.number)) ? Number(handoff.pr.number) : undefined;
  const releaseStatus = RELEASE_CHECK_STATUSES.includes(handoff.releaseCheck?.status)
    ? handoff.releaseCheck.status
    : undefined;
  const worktree =
    handoff.worktree && typeof handoff.worktree === "object"
      ? {
          class: safeLabel(handoff.worktree.class, 80),
          basename: safeLabel(handoff.worktree.basename, 80)
        }
      : undefined;
  const sanitized = {
    schemaVersion: 1,
    status: status ?? (threadId || action ? "recorded" : undefined),
    action,
    sourceSessionId: safeText(handoff.sourceSessionId, 120),
    threadId,
    target: safeLabel(handoff.target, 120),
    repository: safeLabel(handoff.repository, 120),
    package: safeLabel(handoff.package, 120),
    branch: safeLabel(handoff.branch, 160),
    worktree: worktree?.class || worktree?.basename ? worktree : undefined,
    pr: prUrl || prNumber ? { url: prUrl, number: prNumber } : undefined,
    releaseCheck: releaseStatus ? { status: releaseStatus } : undefined,
    nextAdr: safeLabel(handoff.nextAdr, 120),
    recordedAt: typeof handoff.recordedAt === "string" ? handoff.recordedAt : undefined
  };
  return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined));
}

function buildThreadHandoff(snapshot, run, options, recordedAt) {
  const threadId = safeText(options.threadId, 120);
  const existingPr = run.pr && typeof run.pr === "object" ? run.pr : undefined;
  const prUrl = sanitizePrUrl(options.prUrl) ?? sanitizePrUrl(existingPr?.url);
  const prNumber = Number.isInteger(options.prNumber)
    ? options.prNumber
    : Number.isInteger(Number(existingPr?.number))
      ? Number(existingPr.number)
      : undefined;
  const handoff = {
    schemaVersion: 1,
    status: "recorded",
    action: options.action,
    sourceSessionId: safeText(options.sourceSession, 120),
    threadId,
    target: safeLabel(options.target, 120),
    repository: safeLabel(options.repoLabel, 120),
    package: safeLabel(options.packageLabel, 120),
    branch: safeLabel(options.branch ?? run.branch ?? snapshot.topology.branch, 160),
    worktree: worktreePathClass(snapshot, options.worktree ?? run.worktreePath, options.worktreeClass),
    pr: prUrl || prNumber ? { url: prUrl, number: prNumber } : undefined,
    releaseCheck: options.releaseCheck ? { status: options.releaseCheck } : undefined,
    nextAdr: safeLabel(options.nextAdr, 120),
    recordedAt
  };
  if (!handoff.threadId && ["create", "send", "handoff"].includes(handoff.action)) {
    throw new Error("--thread-id is required for create, send, and handoff actions.");
  }
  if (!handoff.target && options.target !== undefined) {
    throw new Error("Refusing unsafe --target value.");
  }
  if (!handoff.repository && options.repoLabel !== undefined) {
    throw new Error("Refusing unsafe --repo value.");
  }
  if (!handoff.package && options.packageLabel !== undefined) {
    throw new Error("Refusing unsafe --package value.");
  }
  return sanitizeThreadHandoff(handoff);
}

function recordThreadHandoff(snapshot, repoDir, options) {
  const ledgerFile = join(repoDir, "ledger.json");
  const ledger = readJson(ledgerFile, { schemaVersion: 3, runs: [] });
  const runs = Array.isArray(ledger.runs) ? ledger.runs : [];
  const id = sanitizeRunId(options.runId);
  const index = runs.findIndex((run) => run?.id === id);
  if (index === -1) throw new Error(`Cannot record thread handoff for unknown Auto Git run: ${id}`);
  const recordedAt = nowIso();
  const nextRun = {
    ...runs[index],
    threadHandoff: buildThreadHandoff(snapshot, runs[index], options, recordedAt)
  };
  const nextRuns = [...runs];
  nextRuns[index] = nextRun;
  const nextLedger = { ...ledger, schemaVersion: 3, updatedAt: recordedAt, runs: nextRuns };
  writeJson(ledgerFile, nextLedger);
  return { ledger: nextLedger, run: nextRun };
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
    releasePreflight: run.releasePreflight,
    releaseExecution: run.releaseExecution,
    releaseDeferral: run.releaseDeferral,
    threadHandoff: sanitizeThreadHandoff(run.threadHandoff),
    decisionReceipt: run.decisionReceipt
  };
}

function buildReceipt(options) {
  const cwd = resolve(options.cwd);
  const snapshot = runSnapshot(cwd);
  const repoDir = join(stateRoot(), "repos", snapshot.repo.hash || sha256(snapshot.repo.root, 24));
  let mutation;
  if (options.command === "record-thread") {
    mutation = recordThreadHandoff(snapshot, repoDir, options);
  }
  const ledger = mutation?.ledger ?? readJson(join(repoDir, "ledger.json"), { schemaVersion: 3, runs: [] });
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
  } else if (options.command === "record-thread") {
    selectedRuns = runs.filter((run) => run.id === options.runId);
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
    mutation: mutation ? { type: "record-thread", runId: options.runId } : undefined,
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
    const thread = run.threadHandoff?.action
      ? ` thread=${run.threadHandoff.action}${run.threadHandoff.threadId ? `:${run.threadHandoff.threadId}` : ""}`
      : "";
    const decision = run.decisionReceipt?.normalizedIntentLabel ? ` decision=${run.decisionReceipt.normalizedIntentLabel}` : "";
    console.log(`${run.id} status=${run.status} lifecycle=${run.lifecycle} intent=${run.intent}${decision} branch=${run.branch ?? "none"}${pr}${thread}`);
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
