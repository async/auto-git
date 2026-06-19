import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_LOCK_ROOT = join(homedir(), ".async", "locks");

export function autoGitLockRoot() {
  return process.env.AUTO_GIT_LOCK_HOME || process.env.ASYNC_LOCK_HOME || DEFAULT_LOCK_ROOT;
}

export function autoGitRunLeasePath(repoHash, runId) {
  return join(autoGitLockRoot(), "auto-git", "repos", safeSegment(repoHash), "runs", `${safeSegment(runId)}.lease.json`);
}

export function displayLockPath(path) {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function readAutoGitRunLease(repoHash, runId) {
  const path = autoGitRunLeasePath(repoHash, runId);
  if (!existsSync(path)) return undefined;
  return readLock(path);
}

export function listAutoGitRunLeases(repoHash, now = new Date()) {
  const root = join(autoGitLockRoot(), "auto-git", "repos", safeSegment(repoHash), "runs");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".lease.json"))
    .sort()
    .map((entry) => {
      const path = join(root, entry);
      try {
        const record = readLock(path);
        return { path, record, status: lockStatus(record, now).status };
      } catch (error) {
        return { path, status: "unknown", error: String(error?.message ?? error) };
      }
    });
}

export function acquireOrHeartbeatAutoGitRunLease(options) {
  const path = autoGitRunLeasePath(options.repoHash, options.runId);
  const now = options.now ?? new Date();
  const existing = existsSync(path) ? readLock(path) : undefined;
  const existingStatus = existing ? lockStatus(existing, now).status : "unknown";
  const leaseId = existing?.lease?.leaseId && existingStatus === "active"
    ? existing.lease.leaseId
    : options.leaseId || randomUUID();
  const createdAt = existing?.lease?.leaseId === leaseId ? existing.createdAt : undefined;

  if (existing && existingStatus !== "active") {
    writeLifecycleReceipt(path, removalRecord(path, existing, {
      now,
      reason: `Replaced ${existingStatus} Auto Git run lease for ${options.runId}.`
    }), "removed");
  }

  const record = autoGitLeaseRecord({
    ...options,
    path,
    leaseId,
    createdAt,
    now
  });
  writeLock(path, record);
  return { path, record, status: "active" };
}

export function heartbeatAutoGitRunLease(options) {
  const existing = readAutoGitRunLease(options.repoHash, options.runId);
  if (!existing) {
    return acquireOrHeartbeatAutoGitRunLease(options);
  }
  if (options.leaseId && existing.lease?.leaseId !== options.leaseId) {
    throw new Error(`Auto Git run ${options.runId} is owned by a different lease.`);
  }
  return acquireOrHeartbeatAutoGitRunLease({
    ...options,
    leaseId: existing.lease?.leaseId
  });
}

export function completeAutoGitRunLease(options) {
  const path = autoGitRunLeasePath(options.repoHash, options.runId);
  if (!existsSync(path)) return { path, completed: false, reason: "lease missing" };
  const now = options.now ?? new Date();
  const record = readLock(path);
  if (options.leaseId && record.lease?.leaseId !== options.leaseId) {
    throw new Error(`Auto Git run ${options.runId} is owned by a different lease.`);
  }
  const completed = {
    ...record,
    updatedAt: now.toISOString(),
    completion: {
      ...record.completion,
      status: "complete",
      completedAt: now.toISOString(),
      summary: options.summary || `Auto Git run ${options.runId} completed.`
    }
  };
  writeLifecycleReceipt(path, completed, "complete");
  rmSync(path, { force: true });
  return { path, completed: true, record: completed };
}

export function autoGitLeaseStatusForRun(run, now = new Date()) {
  if (!run?.leasePath && !(run?.id && run?.repoHash)) return undefined;
  const path = run.leasePath ? expandHomePath(run.leasePath) : autoGitRunLeasePath(run.repoHash, run.id);
  if (!existsSync(path)) return { status: "missing", path: displayLockPath(path) };
  try {
    const record = readLock(path);
    if (run.leaseId && record.lease?.leaseId !== run.leaseId) {
      return { status: "unknown", path: displayLockPath(path), reason: "lease id changed" };
    }
    return { ...lockStatus(record, now), path: displayLockPath(path), record };
  } catch (error) {
    return { status: "unknown", path: displayLockPath(path), reason: String(error?.message ?? error) };
  }
}

export function lockStatus(record, now = new Date()) {
  if (record?.completion?.status && record.completion.status !== "active") {
    return { status: record.completion.status, reason: record.completion.summary || `lock is ${record.completion.status}` };
  }
  const nowMs = now.getTime();
  const expiresAt = Date.parse(record?.expiresAt ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    return { status: "expired", reason: `expired at ${record.expiresAt}` };
  }
  const heartbeatAt = Date.parse(record?.lease?.heartbeatAt ?? "");
  const staleAfterMs = Number(record?.lease?.staleAfterMs);
  if (Number.isFinite(heartbeatAt) && Number.isFinite(staleAfterMs) && heartbeatAt + staleAfterMs <= nowMs) {
    return { status: "stale", reason: `heartbeat stale since ${record.lease.heartbeatAt}` };
  }
  return { status: "active", reason: `lease heartbeat is fresh at ${record?.lease?.heartbeatAt ?? record?.updatedAt ?? record?.createdAt}` };
}

function autoGitLeaseRecord(options) {
  const nowIso = options.now.toISOString();
  const ttlMs = Number(options.ttlMs);
  const expiresAt = new Date(options.now.getTime() + ttlMs).toISOString();
  return stripUndefined({
    version: LOCK_SCHEMA_VERSION,
    kind: "lease",
    persistence: "global",
    scope: "global",
    domain: "auto-git",
    name: `${safeSegment(options.repoHash)}-${safeSegment(options.runId)}`,
    resource: `Auto Git run ${options.runId} for repo ${options.repoHash}`,
    reason: options.reason || "Coordinate Auto Git run ownership.",
    path: displayLockPath(options.path),
    owner: {
      package: "@async/auto-git",
      tool: "auto-git",
      command: "auto-git-snapshot",
      agent: options.agent
    },
    createdAt: options.createdAt || nowIso,
    updatedAt: nowIso,
    expiresAt,
    lease: {
      leaseId: options.leaseId,
      holder: {
        host: hostname(),
        command: "auto-git-snapshot"
      },
      heartbeatAt: nowIso,
      staleAfterMs: ttlMs
    },
    completion: {
      trackable: true,
      status: "active",
      doneWhen: "The Auto Git run is completed, released, expires, or is replaced."
    }
  });
}

function removalRecord(path, record, options) {
  const nowIso = options.now.toISOString();
  const status = lockStatus(record, options.now);
  return stripUndefined({
    ...record,
    updatedAt: nowIso,
    removal: {
      removedAt: nowIso,
      removedBy: { package: "@async/auto-git", tool: "auto-git" },
      reason: options.reason,
      previousPath: displayLockPath(path),
      previousKind: record.kind,
      previousPersistence: record.persistence,
      previousStatus: status.status,
      previousUpdatedAt: record.updatedAt,
      previousLeaseId: record.lease?.leaseId,
      forced: true
    },
    completion: {
      ...record.completion,
      status: "removed",
      completedAt: nowIso,
      summary: options.reason
    }
  });
}

function writeLifecycleReceipt(path, record, suffix) {
  const receiptPath = join(
    autoGitLockRoot(),
    "auto-git",
    "history",
    safeSegment(record.name),
    `${safeTimestamp(record.completion?.completedAt || record.updatedAt || record.createdAt)}-${safeSegment(record.lease?.leaseId || "lease")}.${suffix}.json`
  );
  writeLock(receiptPath, record);
}

function readLock(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.version !== LOCK_SCHEMA_VERSION || record.kind !== "lease" || record.domain !== "auto-git") {
    throw new Error(`Unexpected Auto Git lock record at ${displayLockPath(path)}.`);
  }
  return record;
}

function writeLock(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function expandHomePath(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function safeSegment(value) {
  const safe = String(value ?? "")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "lock";
}

function safeTimestamp(value) {
  return String(value ?? new Date().toISOString())
    .replace(/[^0-9A-Za-z_-]+/g, "-")
    .replace(/-+$/g, "");
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map((entry) => stripUndefined(entry));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) next[key] = stripUndefined(entry);
  }
  return next;
}
