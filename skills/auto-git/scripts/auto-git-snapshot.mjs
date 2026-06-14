#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA_VERSION = 3;
const DEFAULT_LEASE_TTL_MS = 45 * 60 * 1000;
const PACKAGE_MANAGER_HINT_THREAD = "019ebdd4-9cff-76c2-bf71-a3bb38ad1592";

function usage() {
  return [
    "Usage: auto-git-snapshot.mjs [--cwd <repo>] [--write-state]",
    "       [--claim-run <task>] [--run-id <id>] [--intent <name>]",
    "       [--lifecycle <checkpoint|sync|land|fanout|everything>]",
    "       [--heartbeat-run <run-id>] [--complete-run <run-id>]",
    "       [--record-pr <run-id> --pr-url <url> [--pr-number <n>]]",
    "       [--lease-ttl-ms <n>]",
    "       [--record-verification <name> --exit-code <n>]",
    "       [--execution-profile <name>] [--duration-ms <n>] [--failure-class <name>]",
    "",
    "Emits a compact JSON snapshot for Auto Git. With --write-state, state writes",
    "are advisory and fail soft via stateWrite.ok=false."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    writeState: false,
    claimRun: undefined,
    runId: undefined,
    intent: undefined,
    lifecycle: undefined,
    heartbeatRun: undefined,
    completeRun: undefined,
    recordPr: undefined,
    prUrl: undefined,
    prNumber: undefined,
    prBranch: undefined,
    prStatus: "open",
    baseBranch: undefined,
    leaseTtlMs: DEFAULT_LEASE_TTL_MS,
    recordVerification: undefined,
    exitCode: undefined,
    executionProfile: "default",
    durationMs: undefined,
    failureClass: undefined
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
    if (arg === "--write-state") {
      parsed.writeState = true;
      continue;
    }
    if (arg === "--claim-run") {
      parsed.claimRun = requireValue(argv, ++index, arg);
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
    if (arg === "--heartbeat-run") {
      parsed.heartbeatRun = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--complete-run") {
      parsed.completeRun = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--record-pr") {
      parsed.recordPr = requireValue(argv, ++index, arg);
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
    if (arg === "--pr-branch") {
      parsed.prBranch = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--pr-status") {
      parsed.prStatus = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--base-branch") {
      parsed.baseBranch = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--lease-ttl-ms") {
      parsed.leaseTtlMs = Number(requireValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--record-verification") {
      parsed.recordVerification = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--exit-code") {
      parsed.exitCode = Number(requireValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--execution-profile") {
      parsed.executionProfile = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--duration-ms") {
      parsed.durationMs = Number(requireValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--failure-class") {
      parsed.failureClass = requireValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.recordVerification !== undefined && !Number.isInteger(parsed.exitCode)) {
    throw new Error("--record-verification requires --exit-code <n>.");
  }
  const mutatesLedger =
    parsed.claimRun !== undefined ||
    parsed.heartbeatRun !== undefined ||
    parsed.completeRun !== undefined ||
    parsed.recordPr !== undefined;
  if (mutatesLedger && !parsed.writeState) {
    throw new Error("Run ledger updates require --write-state.");
  }
  if (!Number.isFinite(parsed.leaseTtlMs) || parsed.leaseTtlMs <= 0) {
    throw new Error("--lease-ttl-ms must be a positive number.");
  }
  if (
    parsed.intent !== undefined &&
    !["merge", "branch", "experiment", "checkpoint", "release", "unknown"].includes(parsed.intent)
  ) {
    throw new Error("--intent must be one of merge, branch, experiment, checkpoint, release, or unknown.");
  }
  if (parsed.lifecycle !== undefined && !["checkpoint", "sync", "land", "fanout", "everything"].includes(parsed.lifecycle)) {
    throw new Error("--lifecycle must be one of checkpoint, sync, land, fanout, or everything.");
  }
  if (parsed.recordPr !== undefined && parsed.prUrl === undefined) {
    throw new Error("--record-pr requires --pr-url <url>.");
  }
  if (parsed.prNumber !== undefined && !Number.isInteger(parsed.prNumber)) {
    throw new Error("--pr-number must be an integer.");
  }
  if (!["open", "draft", "closed", "merged"].includes(parsed.prStatus)) {
    throw new Error("--pr-status must be one of open, draft, closed, or merged.");
  }
  if (
    parsed.recordVerification !== undefined &&
    /(?:TOKEN|SECRET|PASSWORD|AUTH|_authToken)\s*=/i.test(parsed.recordVerification)
  ) {
    throw new Error("Refusing to record a verification name that looks like it contains a secret assignment.");
  }
  for (const [name, value] of [
    ["--claim-run", parsed.claimRun],
    ["--run-id", parsed.runId],
    ["--lifecycle", parsed.lifecycle],
    ["--heartbeat-run", parsed.heartbeatRun],
    ["--complete-run", parsed.completeRun],
    ["--record-pr", parsed.recordPr],
    ["--pr-url", parsed.prUrl],
    ["--pr-branch", parsed.prBranch],
    ["--base-branch", parsed.baseBranch]
  ]) {
    if (typeof value === "string" && looksSecretish(value)) {
      throw new Error(`Refusing ${name} value that looks like it contains a secret.`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trimEnd()
  };
}

function runPs(pid) {
  const fixture = readJsonEnv("AUTO_GIT_PS_FIXTURE");
  const fixed = fixture?.[String(pid)];
  if (fixed) return normalizePsInfo(fixed);

  const result = spawnSync("ps", ["-o", "pid=,ppid=,pgid=,comm=,args=", "-p", String(pid)], {
    encoding: "utf8"
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return parsePsLine(result.stdout.trim().split("\n")[0]);
}

function parsePsLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const [pid, ppid, pgid, command, ...args] = parts;
  return normalizePsInfo({
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    command,
    args: args.join(" ")
  });
}

function normalizePsInfo(info) {
  if (!info || !Number.isInteger(Number(info.pid))) return undefined;
  return {
    pid: Number(info.pid),
    ppid: Number.isInteger(Number(info.ppid)) ? Number(info.ppid) : undefined,
    pgid: Number.isInteger(Number(info.pgid)) ? Number(info.pgid) : undefined,
    command: typeof info.command === "string" ? basename(info.command) : undefined,
    args: typeof info.args === "string" ? info.args : undefined
  };
}

function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}

function sha256(value, length = 64) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function nowDate() {
  const fixture = process.env.AUTO_GIT_NOW;
  if (fixture) {
    const parsed = new Date(fixture);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function looksSecretish(value) {
  return /(?:TOKEN|SECRET|PASSWORD|PASSWD|_authToken|ACCESS_KEY|PRIVATE_KEY)\s*[=:]/i.test(value);
}

function sanitizeRunId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeTaskSlug(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "auto-git-run";
}

function classifyIntent(value, explicitIntent) {
  if (explicitIntent) return explicitIntent;
  const text = String(value ?? "").toLowerCase();
  if (/\b(testing something|experimenting|experiment|try this|trying this|not sure|unsure|spike|prototype)\b/.test(text)) {
    return "experiment";
  }
  if (
    /\b(make|create|start|put)\s+(a\s+)?branch\b|\bbranch this\b|\bput this on a branch\b/.test(text) ||
    /\b(open|create|prepare)\s+(a\s+)?(?:pr|pull request)\b|\bpr this\b/.test(text)
  ) {
    return "branch";
  }
  if (/\b(save|checkpoint|commit this locally|commit locally|local checkpoint)\b/.test(text)) {
    return "checkpoint";
  }
  if (/\b(release this|cut v?\d+\.\d+\.\d+|version bump|bump version|prepare changelog|changelog|release notes?)\b/.test(text)) {
    return "release";
  }
  if (/\b(get this in|ship|finish|land|merge-ready|ready to merge|merge this|merge-ready|ready-pr)\b/.test(text)) {
    return "merge";
  }
  return "unknown";
}

function classifyLifecycle(value, explicitLifecycle) {
  if (explicitLifecycle) return explicitLifecycle;
  const text = String(value ?? "").toLowerCase();
  if (/\b(multiple agents|separate features|worktrees|do not step on each other|fanout)\b/.test(text)) {
    return "fanout";
  }
  if (/\b(do everything|everything mode|fully manage|manage all git|handle all git|all the git)\b/.test(text)) {
    return "everything";
  }
  if (/\b(finish|land|merge back|merge it|return to main|switch back to main)\b/.test(text)) {
    return "land";
  }
  if (/\b(push|sync|keep remote latest|publish this branch)\b/.test(text)) {
    return "sync";
  }
  return "checkpoint";
}

function repoSlug(repoRoot) {
  return basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
}

function defaultBaseBranch(snapshot) {
  const remoteHead = snapshot.topology.defaultRemoteHead;
  if (remoteHead?.includes("/")) return remoteHead.split("/").pop();
  return remoteHead || "main";
}

function branchExists(repoRoot, branch) {
  if (!branch) return false;
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function commitsAheadOfBase(repoRoot, baseBranch) {
  if (!baseBranch || !branchExists(repoRoot, baseBranch)) return [];
  const result = runGit(repoRoot, ["rev-list", "--reverse", `${baseBranch}..HEAD`]);
  return result.ok ? lines(result.stdout) : [];
}

function gitDirPath(repoRoot, gitDirOutput) {
  if (!gitDirOutput) return undefined;
  return isAbsolute(gitDirOutput) ? gitDirOutput : resolve(repoRoot, gitDirOutput);
}

function statFile(path) {
  try {
    const stat = statSync(path);
    return { exists: true, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: false, error: String(error?.message ?? error) };
  }
}

function classifyGitIndexLock(repoRoot, gitDir) {
  if (!gitDir) return { status: "unknown", reason: "git dir unavailable" };
  const path = join(gitDir, "index.lock");
  const file = statFile(path);
  return {
    status: file.exists ? "present" : "absent",
    path: relative(repoRoot, path),
    ...file
  };
}

function classifyGitIndexWrite(repoRoot, gitDir, gitIndexLock) {
  if (!gitDir) return { ok: false, status: "unknown", reason: "git dir unavailable" };
  if (gitIndexLock.status === "present") {
    return { ok: false, status: "locked", reason: ".git/index.lock is present" };
  }

  const probePath = join(gitDir, `.auto-git-write-test-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probePath, "", { flag: "wx" });
    unlinkSync(probePath);
    return { ok: true, status: "writable" };
  } catch (error) {
    try {
      if (existsSync(probePath)) unlinkSync(probePath);
    } catch {
      // Best-effort cleanup for a zero-byte probe file.
    }
    return {
      ok: false,
      status: error?.code === "EACCES" || error?.code === "EPERM" ? "blocked" : "unknown",
      reason: String(error?.message ?? error)
    };
  }
}

function pidProbe(pid) {
  const fixture = readJsonEnv("AUTO_GIT_PID_PROBE_FIXTURE");
  const fixed = fixture?.[String(pid)];
  if (fixed?.status) {
    return { status: fixed.status, pid, reason: fixed.reason };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "malformed", reason: "missing numeric pid" };
  }
  try {
    process.kill(pid, 0);
    return { status: "active", pid };
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "stale", pid };
    if (error?.code === "EPERM") return { status: "active-inaccessible", pid };
    return { status: "unknown", pid, reason: String(error?.message ?? error) };
  }
}

function classifyLockPid(repoRoot, pid) {
  const state = pidProbe(pid);
  if (state.status !== "active" && state.status !== "active-inaccessible") {
    return state;
  }

  const ps = runPs(pid);
  const argsIncludesRepoRoot = Boolean(ps?.args && ps.args.includes(repoRoot));
  if (state.status === "active-inaccessible" && ps && !argsIncludesRepoRoot) {
    return {
      status: "stale-candidate",
      pid,
      reason: "pid exists but process metadata does not reference this repo",
      process: summarizeProcess(ps, repoRoot)
    };
  }

  return {
    ...state,
    process: ps ? summarizeProcess(ps, repoRoot) : undefined
  };
}

function summarizeProcess(ps, repoRoot) {
  return {
    pid: ps.pid,
    ppid: ps.ppid,
    pgid: ps.pgid,
    command: ps.command,
    argsIncludesRepoRoot: Boolean(ps.args && ps.args.includes(repoRoot))
  };
}

function classifyAsyncRunLock(repoRoot, lockPath) {
  const file = statFile(lockPath);
  const relativePath = relative(repoRoot, lockPath);
  if (!file.exists) return { status: "absent", path: relativePath };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = Number(parsed.pid);
    const state = classifyLockPid(repoRoot, pid);
    return {
      path: relativePath,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      ...file,
      ...state
    };
  } catch (error) {
    return { status: "malformed", path: relativePath, ...file, reason: String(error?.message ?? error) };
  }
}

function discoverAsyncRunLocks(repoRoot) {
  const lockPaths = [join(repoRoot, ".async", "run.lock")];
  const examplesDir = join(repoRoot, "examples");
  if (existsSync(examplesDir)) {
    for (const path of walkForRunLocks(examplesDir)) {
      lockPaths.push(path);
    }
  }

  const unique = [...new Set(lockPaths)];
  return unique.map((path) => classifyAsyncRunLock(repoRoot, path));
}

function walkForRunLocks(dir) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name === ".async") {
      found.push(join(fullPath, "run.lock"));
      continue;
    }
    found.push(...walkForRunLocks(fullPath));
  }
  return found;
}

function readPackageJson(repoRoot) {
  const path = join(repoRoot, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    return {
      exists: true,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
      scriptNames: Object.keys(scripts).sort(),
      scripts,
      hasVerify: typeof scripts.verify === "string",
      hasReleaseCheck: typeof scripts["release:check"] === "string",
      hasNpmPackScript: Object.values(scripts).some((value) => typeof value === "string" && /\bnpm\s+pack\b/.test(value))
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, scriptNames: [], scripts: {} };
    return { exists: false, scriptNames: [], scripts: {}, error: String(error?.message ?? error) };
  }
}

function npmTempEnv(repoRoot) {
  const slug = repoSlug(repoRoot);
  return {
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_CACHE: `/private/tmp/${slug}-npm-cache`,
    NPM_CONFIG_LOGS_DIR: `/private/tmp/${slug}-npm-logs`
  };
}

function isAsyncPipelineRepo(repoRoot, packageJson) {
  return basename(repoRoot) === "async-pipeline" || packageJson.name === "async-pipeline-workspace";
}

function packageManagerHints(repoRoot, packageJson, asyncRunLocks) {
  const retryEnv = npmTempEnv(repoRoot);
  const hints = [
    {
      id: "package-manager-sandbox-cache",
      appliesWhen: ["npm or pnpm fails writing HOME cache/log/config paths in a sandbox", "pnpm scripts spawn npm commands"],
      startWithPlainCommand: true,
      retryEnv,
      preserve: ["pnpm minimumReleaseAge and other supply-chain delay settings"],
      provenance: {
        threadId: PACKAGE_MANAGER_HINT_THREAD,
        note: "Codex sandbox package-manager cache/log/config write-path investigation"
      }
    }
  ];

  const hasAsyncEvidence = asyncRunLocks.some((lock) => lock.status !== "absent") || existsSync(join(repoRoot, ".async", "runs"));
  if (isAsyncPipelineRepo(repoRoot, packageJson) || hasAsyncEvidence) {
    hints.push({
      id: "async-pipeline-run-lock",
      appliesWhen: ["repo-local or example .async/run.lock exists", "async-pipeline verification was interrupted"],
      lockPaths: asyncRunLocks.map((lock) => lock.path),
      staleCheck: "parse pid and startedAt, then inspect kill -0 and ps metadata; remove only confirmed stale locks"
    });
  }
  if (isAsyncPipelineRepo(repoRoot, packageJson)) {
    hints.push({
      id: "async-pipeline-release-check",
      appliesWhen: ["running full async-pipeline release gate from Codex"],
      commandName: "pnpm release:check",
      retryEnv,
      executionProfile: "loopback-capable",
      startWithPlainCommand: false,
      note: "Tests that bind 127.0.0.1 may need execution outside restricted sandboxes."
    });
  }
  return hints;
}

function buildExecutionPlan(repoRoot, packageJson, asyncRunLocks, gitIndexWrite) {
  const retryEnv = npmTempEnv(repoRoot);
  const asyncPipeline = isAsyncPipelineRepo(repoRoot, packageJson);
  const verification = asyncPipeline
    ? {
        name: "pnpm release:check",
        command: ["pnpm", "release:check"],
        executionProfile: "loopback-capable",
        env: retryEnv,
        reason: "async-pipeline release checks may bind loopback and spawn npm pack"
      }
    : packageJson.hasVerify
      ? {
          name: "pnpm verify",
          command: ["pnpm", "verify"],
          executionProfile: "default",
          env: {},
          reason: "repo exposes a verify script"
        }
      : undefined;

  return {
    preflight: {
      runLockPaths: asyncRunLocks.map((lock) => lock.path),
      gitIndexWritesNeedEscalation: gitIndexWrite.ok === false,
      beforeVerification: asyncPipeline ? ["scan root and examples/**/.async/run.lock"] : ["scan root .async/run.lock when present"]
    },
    verification,
    finalCleanup: [
      "git status --short --branch",
      "HEAD vs upstream",
      "root and examples/**/.async/run.lock",
      "verification process groups started by Auto Git"
    ]
  };
}

function commandFailure(command) {
  return command.ok ? undefined : { status: command.status, stderr: command.stderr.split("\n").slice(0, 3).join("\n") };
}

function buildSnapshot(cwd) {
  const requestedCwd = resolve(cwd);
  const rootCommand = runGit(requestedCwd, ["rev-parse", "--show-toplevel"]);
  if (!rootCommand.ok) {
    throw new Error(`Not a Git repository: ${requestedCwd}`);
  }

  const repoRoot = rootCommand.stdout;
  const gitDirCommand = runGit(repoRoot, ["rev-parse", "--git-dir"]);
  const gitDir = gitDirPath(repoRoot, gitDirCommand.stdout);
  const gitIndexLock = classifyGitIndexLock(repoRoot, gitDir);
  const gitIndexWrite = classifyGitIndexWrite(repoRoot, gitDir, gitIndexLock);
  const asyncRunLocks = discoverAsyncRunLocks(repoRoot);
  const rootAsyncRunLock = asyncRunLocks.find((lock) => lock.path === ".async/run.lock") ?? {
    status: "absent",
    path: ".async/run.lock"
  };

  const head = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const branch = runGit(repoRoot, ["branch", "--show-current"]);
  const upstream = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const defaultRemoteHead = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const statusPorcelain = runGit(repoRoot, ["status", "--porcelain=v1"]);
  const diffNameStatus = runGit(repoRoot, ["diff", "--name-status"]);
  const diffStat = runGit(repoRoot, ["diff", "--stat"]);
  const stagedNameStatus = runGit(repoRoot, ["diff", "--cached", "--name-status"]);
  const stagedStat = runGit(repoRoot, ["diff", "--cached", "--stat"]);
  const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const worktrees = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const remoteNames = runGit(repoRoot, ["remote"]);
  const aheadBehind = upstream.ok
    ? runGit(repoRoot, ["rev-list", "--left-right", "--count", `${upstream.stdout}...HEAD`])
    : { ok: false, stdout: "", stderr: "no upstream" };
  const aheadBehindParts = aheadBehind.ok ? aheadBehind.stdout.trim().split(/\s+/).map(Number) : [];

  const inventory = {
    statusPorcelain: lines(statusPorcelain.stdout),
    diffNameStatus: lines(diffNameStatus.stdout),
    diffStat: lines(diffStat.stdout),
    stagedNameStatus: lines(stagedNameStatus.stdout),
    stagedStat: lines(stagedStat.stdout),
    untracked: lines(untracked.stdout)
  };
  const dirtyFingerprintInput = JSON.stringify({
    head: head.stdout,
    upstream: upstream.ok ? upstream.stdout : undefined,
    status: inventory.statusPorcelain,
    diffNameStatus: inventory.diffNameStatus,
    stagedNameStatus: inventory.stagedNameStatus,
    untracked: inventory.untracked
  });
  const stagedFingerprintInput = JSON.stringify({
    head: head.stdout,
    stagedNameStatus: inventory.stagedNameStatus,
    stagedStat: inventory.stagedStat
  });
  const packageJson = readPackageJson(repoRoot);
  const hints = packageManagerHints(repoRoot, packageJson, asyncRunLocks);
  const executionPlan = buildExecutionPlan(repoRoot, packageJson, asyncRunLocks, gitIndexWrite);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowDate().toISOString(),
    repo: {
      root: repoRoot,
      hash: sha256(repoRoot, 24),
      slug: repoSlug(repoRoot),
      gitDir: gitDir ? relative(repoRoot, gitDir) || ".git" : undefined
    },
    topology: {
      head: head.ok ? head.stdout : undefined,
      branch: branch.ok && branch.stdout ? branch.stdout : undefined,
      detached: branch.ok ? branch.stdout.length === 0 : undefined,
      upstream: upstream.ok ? upstream.stdout : undefined,
      defaultRemoteHead: defaultRemoteHead.ok ? defaultRemoteHead.stdout : undefined,
      remoteNames: remoteNames.ok ? lines(remoteNames.stdout) : [],
      ahead: aheadBehindParts.length === 2 ? aheadBehindParts[1] : undefined,
      behind: aheadBehindParts.length === 2 ? aheadBehindParts[0] : undefined,
      failures: {
        head: commandFailure(head),
        status: commandFailure(statusPorcelain),
        upstream: upstream.ok ? undefined : { stderr: upstream.stderr || "no upstream" }
      }
    },
    dirty: {
      isDirty: inventory.statusPorcelain.length > 0,
      fingerprint: sha256(dirtyFingerprintInput),
      stagedFingerprint: sha256(stagedFingerprintInput),
      ...inventory
    },
    git: {
      indexWrite: gitIndexWrite
    },
    locks: {
      gitIndex: gitIndexLock,
      asyncRun: rootAsyncRunLock,
      asyncRunLocks
    },
    worktrees: worktrees.ok ? lines(worktrees.stdout) : [],
    packageManager: {
      packageJson: {
        exists: packageJson.exists,
        name: packageJson.name,
        packageManager: packageJson.packageManager,
        scriptNames: packageJson.scriptNames,
        hasVerify: packageJson.hasVerify,
        hasReleaseCheck: packageJson.hasReleaseCheck,
        hasNpmPackScript: packageJson.hasNpmPackScript
      },
      usesPnpm: packageJson.packageManager?.startsWith("pnpm@") || existsSync(join(repoRoot, "pnpm-lock.yaml")),
      hints
    },
    executionPlan
  };
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

function ledgerPath(repoDir) {
  return join(repoDir, "ledger.json");
}

function readLedger(repoDir) {
  const ledger = readJson(ledgerPath(repoDir), { schemaVersion: SCHEMA_VERSION, runs: [] });
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: typeof ledger.updatedAt === "string" ? ledger.updatedAt : undefined,
    runs: Array.isArray(ledger.runs) ? ledger.runs.map(normalizeRun).filter(Boolean).slice(0, 100) : []
  };
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") return undefined;
  const id = sanitizeRunId(run.id);
  if (!id) return undefined;
  return {
    id,
    taskSlug: sanitizeTaskSlug(run.taskSlug),
    intent: ["merge", "branch", "experiment", "checkpoint", "release", "unknown"].includes(run.intent)
      ? run.intent
      : "unknown",
    lifecycle: ["checkpoint", "sync", "land", "fanout", "everything"].includes(run.lifecycle)
      ? run.lifecycle
      : "checkpoint",
    status: ["active", "completed"].includes(run.status) ? run.status : "active",
    branch: typeof run.branch === "string" ? run.branch : undefined,
    worktreePath: typeof run.worktreePath === "string" ? run.worktreePath : undefined,
    baseBranch: typeof run.baseBranch === "string" ? run.baseBranch : undefined,
    claimedAt: typeof run.claimedAt === "string" ? run.claimedAt : undefined,
    lastHeartbeatAt: typeof run.lastHeartbeatAt === "string" ? run.lastHeartbeatAt : undefined,
    leaseExpiresAt: typeof run.leaseExpiresAt === "string" ? run.leaseExpiresAt : undefined,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
    head: typeof run.head === "string" ? run.head : undefined,
    dirtyFingerprint: typeof run.dirtyFingerprint === "string" ? run.dirtyFingerprint : undefined,
    stagedFingerprint: typeof run.stagedFingerprint === "string" ? run.stagedFingerprint : undefined,
    commits: Array.isArray(run.commits) ? run.commits.filter((commit) => typeof commit === "string").slice(0, 200) : [],
    verification: normalizeVerification(run.verification),
    pr: normalizePr(run.pr)
  };
}

function normalizeVerification(verification) {
  if (!verification || typeof verification !== "object") return undefined;
  return {
    key: typeof verification.key === "string" ? verification.key : undefined,
    name: typeof verification.name === "string" ? verification.name : undefined,
    exitCode: Number.isInteger(Number(verification.exitCode)) ? Number(verification.exitCode) : undefined,
    failureClass: typeof verification.failureClass === "string" ? verification.failureClass : undefined,
    executionProfile: typeof verification.executionProfile === "string" ? verification.executionProfile : undefined,
    durationMs: Number.isFinite(Number(verification.durationMs)) ? Number(verification.durationMs) : undefined,
    recordedAt: typeof verification.recordedAt === "string" ? verification.recordedAt : undefined,
    head: typeof verification.head === "string" ? verification.head : undefined,
    dirtyFingerprint: typeof verification.dirtyFingerprint === "string" ? verification.dirtyFingerprint : undefined
  };
}

function normalizePr(pr) {
  if (!pr || typeof pr !== "object") return undefined;
  return {
    url: typeof pr.url === "string" ? pr.url : undefined,
    number: Number.isInteger(Number(pr.number)) ? Number(pr.number) : undefined,
    branch: typeof pr.branch === "string" ? pr.branch : undefined,
    baseBranch: typeof pr.baseBranch === "string" ? pr.baseBranch : undefined,
    status: ["open", "draft", "closed", "merged"].includes(pr.status) ? pr.status : "open",
    recordedAt: typeof pr.recordedAt === "string" ? pr.recordedAt : undefined
  };
}

function upsertRun(runs, run) {
  const index = runs.findIndex((existing) => existing.id === run.id);
  if (index === -1) return [run, ...runs].slice(0, 100);
  const nextRuns = [...runs];
  nextRuns[index] = { ...nextRuns[index], ...run };
  return nextRuns;
}

function currentRunBasis(snapshot, options, nowIso) {
  const baseBranch = options.baseBranch ?? defaultBaseBranch(snapshot);
  const commits = commitsAheadOfBase(snapshot.repo.root, baseBranch);
  return {
    branch: snapshot.topology.branch,
    worktreePath: snapshot.repo.root,
    baseBranch,
    lastHeartbeatAt: nowIso,
    leaseExpiresAt: isoFromMs(nowDate().getTime() + options.leaseTtlMs),
    head: snapshot.topology.head,
    dirtyFingerprint: snapshot.dirty.fingerprint,
    stagedFingerprint: snapshot.dirty.stagedFingerprint,
    commits
  };
}

function mutateLedger(snapshot, ledger, options, updatedAt) {
  let runs = [...ledger.runs];
  let changed = false;
  let currentRunId = options.runId ? sanitizeRunId(options.runId) : undefined;

  if (options.claimRun) {
    const id = currentRunId || randomUUID();
    currentRunId = id;
    const existing = runs.find((run) => run.id === id);
    const run = {
      ...(existing ?? {}),
      id,
      taskSlug: sanitizeTaskSlug(options.claimRun),
      intent: classifyIntent(options.claimRun, options.intent),
      lifecycle: classifyLifecycle(options.claimRun, options.lifecycle),
      status: "active",
      claimedAt: existing?.claimedAt ?? updatedAt,
      ...currentRunBasis(snapshot, options, updatedAt)
    };
    runs = upsertRun(runs, run);
    changed = true;
  }

  if (options.heartbeatRun) {
    const id = sanitizeRunId(options.heartbeatRun);
    currentRunId = id;
    const existing = runs.find((run) => run.id === id);
    if (!existing) throw new Error(`Cannot heartbeat unknown Auto Git run: ${id}`);
    runs = upsertRun(runs, {
      ...existing,
      status: "active",
      ...currentRunBasis(snapshot, options, updatedAt)
    });
    changed = true;
  }

  if (options.completeRun) {
    const id = sanitizeRunId(options.completeRun);
    currentRunId = id;
    const existing = runs.find((run) => run.id === id);
    if (!existing) throw new Error(`Cannot complete unknown Auto Git run: ${id}`);
    runs = upsertRun(runs, {
      ...existing,
      status: "completed",
      completedAt: updatedAt,
      ...currentRunBasis(snapshot, options, updatedAt)
    });
    changed = true;
  }

  if (options.recordPr) {
    const id = sanitizeRunId(options.recordPr);
    currentRunId = id;
    const existing = runs.find((run) => run.id === id);
    if (!existing) throw new Error(`Cannot record PR for unknown Auto Git run: ${id}`);
    runs = upsertRun(runs, {
      ...existing,
      pr: {
        url: sanitizePrUrl(options.prUrl),
        number: options.prNumber,
        branch: options.prBranch ?? existing.branch ?? snapshot.topology.branch,
        baseBranch: options.baseBranch ?? existing.baseBranch ?? defaultBaseBranch(snapshot),
        status: options.prStatus,
        recordedAt: updatedAt
      }
    });
    changed = true;
  }

  return {
    ledger: { schemaVersion: SCHEMA_VERSION, updatedAt: changed ? updatedAt : ledger.updatedAt, runs },
    changed,
    currentRunId
  };
}

function sanitizePrUrl(value) {
  const url = String(value ?? "").trim();
  if (!url) throw new Error("--pr-url cannot be empty.");
  if (looksSecretish(url) || /[?&](?:token|auth|secret|password|key)=/i.test(url)) {
    throw new Error("Refusing to record a PR URL that looks like it contains a secret.");
  }
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new Error("PR URL contains credentials.");
    }
  } catch (error) {
    if (String(error?.message ?? error).includes("credentials")) throw error;
  }
  return url;
}

function applyVerificationToLedger(snapshot, ledger, options, entry, updatedAt) {
  const run = resolveRunForUpdate(snapshot, ledger, options.runId);
  if (!run) return { ledger, changed: false };
  const nextRun = {
    ...run,
    verification: {
      key: entry.key,
      name: entry.name,
      exitCode: entry.exitCode,
      failureClass: entry.failureClass,
      executionProfile: entry.executionProfile,
      durationMs: entry.durationMs,
      recordedAt: updatedAt,
      head: snapshot.topology.head,
      dirtyFingerprint: snapshot.dirty.fingerprint
    },
    head: snapshot.topology.head,
    dirtyFingerprint: snapshot.dirty.fingerprint,
    stagedFingerprint: snapshot.dirty.stagedFingerprint,
    commits: commitsAheadOfBase(snapshot.repo.root, run.baseBranch ?? defaultBaseBranch(snapshot))
  };
  return {
    ledger: { ...ledger, updatedAt, runs: upsertRun(ledger.runs, nextRun) },
    changed: true
  };
}

function resolveRunForUpdate(snapshot, ledger, runId) {
  const sanitized = runId ? sanitizeRunId(runId) : undefined;
  if (sanitized) return ledger.runs.find((run) => run.id === sanitized);
  const activeOnBranch = ledger.runs.filter(
    (run) => run.status === "active" && run.branch && run.branch === snapshot.topology.branch
  );
  if (activeOnBranch.length === 1) return activeOnBranch[0];
  const activeRuns = ledger.runs.filter((run) => run.status === "active");
  return activeRuns.length === 1 ? activeRuns[0] : undefined;
}

function activeAutoGitProcesses(repoDir) {
  const processes = readJson(join(repoDir, "processes.json"), { entries: [] });
  if (!Array.isArray(processes.entries)) return [];
  return processes.entries
    .map((entry) => {
      const pid = Number(entry?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const state = pidProbe(pid);
      if (state.status !== "active" && state.status !== "active-inaccessible") return undefined;
      return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        pid,
        pgid: Number.isInteger(Number(entry.pgid)) ? Number(entry.pgid) : undefined,
        command: Array.isArray(entry.command) ? entry.command.join(" ") : undefined,
        executionProfile: typeof entry.executionProfile === "string" ? entry.executionProfile : undefined,
        startedAt: typeof entry.startedAt === "string" ? entry.startedAt : undefined
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function runState(snapshot, run, nowMs, hasActiveProcesses) {
  if (run.status === "completed") return "completed";
  const expiresAt = Date.parse(run.leaseExpiresAt ?? "");
  if (Number.isFinite(expiresAt) && expiresAt >= nowMs) return "active";
  if (run.pr && (run.pr.status === "open" || run.pr.status === "draft")) return "stale";
  const branchStillExists = branchExists(snapshot.repo.root, run.branch);
  const worktreeStillExists = Boolean(run.worktreePath && existsSync(run.worktreePath));
  if (!hasActiveProcesses && (branchStillExists || worktreeStillExists)) return "abandoned-candidate";
  return "stale";
}

function publicRun(run, state) {
  return {
    id: run.id,
    taskSlug: run.taskSlug,
    intent: run.intent,
    lifecycle: run.lifecycle,
    status: state,
    branch: run.branch,
    worktreePath: run.worktreePath,
    baseBranch: run.baseBranch,
    claimedAt: run.claimedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
    completedAt: run.completedAt,
    head: run.head,
    dirtyFingerprint: run.dirtyFingerprint,
    stagedFingerprint: run.stagedFingerprint,
    commits: run.commits,
    verification: run.verification,
    pr: run.pr
  };
}

function chooseContextRun(snapshot, runsWithState, currentRunId) {
  if (currentRunId) {
    const self = runsWithState.find((entry) => entry.run.id === currentRunId);
    if (self) return self.run;
  }
  const currentBranch = snapshot.topology.branch;
  return (
    runsWithState.find((entry) => entry.run.branch === currentBranch && entry.state === "active")?.run ??
    runsWithState.find((entry) => entry.run.branch === currentBranch && entry.run.pr)?.run
  );
}

function attachCoordination(snapshot, ledger, repoDir, currentRunId) {
  const processes = activeAutoGitProcesses(repoDir);
  const hasActiveProcesses = processes.length > 0;
  const nowMs = nowDate().getTime();
  const runsWithState = ledger.runs.map((run) => ({ run, state: runState(snapshot, run, nowMs, hasActiveProcesses) }));
  const activeRuns = runsWithState.filter((entry) => entry.state === "active");
  const staleRuns = runsWithState.filter((entry) => entry.state === "stale" || entry.state === "abandoned-candidate");
  const selfActive = currentRunId ? activeRuns.find((entry) => entry.run.id === currentRunId) : undefined;
  const activeOthers = currentRunId ? activeRuns.filter((entry) => entry.run.id !== currentRunId) : activeRuns;
  const abandoned = staleRuns.filter((entry) => entry.state === "abandoned-candidate");
  const openPrs = runsWithState
    .filter((entry) => entry.run.pr && (entry.run.pr.status === "open" || entry.run.pr.status === "draft"))
    .map((entry) => publicRun(entry.run, entry.state));
  const contextRun = chooseContextRun(snapshot, runsWithState, currentRunId);
  const status = selfActive
    ? "self"
    : activeOthers.length > 0
      ? "occupied"
      : abandoned.length > 0
        ? "abandoned-candidate"
        : staleRuns.length > 0
          ? "stale"
          : "free";

  snapshot.ledger = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: ledger.updatedAt,
    currentRunId
  };
  snapshot.occupancy = {
    status,
    activeRuns: activeRuns.map((entry) => publicRun(entry.run, entry.state)),
    staleRuns: staleRuns.map((entry) => publicRun(entry.run, entry.state)),
    activeAutoGitProcesses: processes
  };
  snapshot.handoffs = { openPrs };
  snapshot.workflowMode = workflowMode(status, contextRun);
  snapshot.recommendedAction = recommendedAction(snapshot, status, contextRun);
  snapshot.prReadiness = prReadiness(snapshot, contextRun, openPrs);
}

function shouldUseCoordinatedWorkflow(run) {
  return Boolean(
    run && (["merge", "branch", "experiment"].includes(run.intent) || ["fanout", "everything"].includes(run.lifecycle))
  );
}

function workflowMode(status, run) {
  if (status === "occupied" || status === "stale" || status === "abandoned-candidate") {
    return "coordinated-branch";
  }
  return shouldUseCoordinatedWorkflow(run) ? "coordinated-branch" : "local-review";
}

function recommendedAction(snapshot, status, run) {
  if (status === "occupied") return "create-or-reuse-isolated-worktree";
  if (status === "abandoned-candidate") return "inspect-stale-run-or-supersede-with-new-branch";
  if (status === "stale") return "review-stale-handoff-before-new-work";
  const baseBranch = defaultBaseBranch(snapshot);
  const onBaseBranch = snapshot.topology.branch === baseBranch;
  if (status === "self") {
    if (shouldUseCoordinatedWorkflow(run) && onBaseBranch) {
      return "create-or-reuse-isolated-worktree-for-coordinated-run";
    }
    if (run?.intent === "experiment") return "checkpoint-locally-no-pr";
    if (run?.intent === "checkpoint") return "commit-locally-no-pr";
    if (run?.intent === "release") return "commit-release-locally-or-follow-lifecycle";
    if (run?.intent === "unknown") return "commit-locally-for-review";
    return "continue-run-and-prepare-pr-handoff";
  }
  if (onBaseBranch) return "claim-run-and-continue-local-review";
  return "claim-run-and-continue-current-branch";
}

function prReadiness(snapshot, run, openPrs) {
  if (!run) return openPrs.length > 0 ? "merge-candidate" : "none";
  if (run.intent === "experiment" || run.intent === "checkpoint") return "none";
  const hasCommits = (run.commits ?? []).length > 0 || Boolean(snapshot.topology.ahead && snapshot.topology.ahead > 0);
  if (!hasCommits) return run.pr ? "draft-pr" : "none";
  const verificationPassed =
    run.verification?.exitCode === 0 &&
    run.verification?.head === snapshot.topology.head &&
    run.verification?.dirtyFingerprint === snapshot.dirty.fingerprint;
  if (run.pr && verificationPassed && !snapshot.dirty.isDirty) return "merge-candidate";
  if (verificationPassed && !snapshot.dirty.isDirty) return "ready-pr";
  return "draft-pr";
}

function envOverridesForProfile(snapshot, profile) {
  const verification = snapshot.executionPlan.verification;
  if (verification?.executionProfile === profile) return verification.env ?? {};
  return {};
}

function writeState(snapshot, options) {
  try {
    const root = stateRoot();
    const repoDir = join(root, "repos", snapshot.repo.hash);
    mkdirSync(repoDir, { recursive: true });
    const updatedAt = nowDate().toISOString();
    let ledgerResult = mutateLedger(snapshot, readLedger(repoDir), options, updatedAt);
    let ledgerChanged = ledgerResult.changed;
    const storedSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      snapshot
    };

    if (options.recordVerification) {
      const verificationPath = join(repoDir, "verifications.json");
      const existing = readJson(verificationPath, { schemaVersion: SCHEMA_VERSION, entries: [] });
      const entry = {
        recordedAt: updatedAt,
        name: options.recordVerification,
        exitCode: options.exitCode,
        failureClass: options.failureClass,
        reusable: options.exitCode === 0,
        executionProfile: options.executionProfile,
        envOverrides: envOverridesForProfile(snapshot, options.executionProfile),
        durationMs: Number.isFinite(options.durationMs) ? options.durationMs : undefined,
        head: snapshot.topology.head,
        upstream: snapshot.topology.upstream,
        dirtyFingerprint: snapshot.dirty.fingerprint,
        key: sha256(
          JSON.stringify({
            head: snapshot.topology.head,
            upstream: snapshot.topology.upstream,
            dirtyFingerprint: snapshot.dirty.fingerprint,
            name: options.recordVerification,
            executionProfile: options.executionProfile
          }),
          32
        )
      };
      const entries = [entry, ...(existing.entries ?? [])].slice(0, 50);
      writeJson(verificationPath, { schemaVersion: SCHEMA_VERSION, updatedAt, entries });
      const verificationLedger = applyVerificationToLedger(snapshot, ledgerResult.ledger, options, entry, updatedAt);
      ledgerResult = { ...ledgerResult, ledger: verificationLedger.ledger };
      ledgerChanged = ledgerChanged || verificationLedger.changed;
    }

    attachCoordination(snapshot, ledgerResult.ledger, repoDir, ledgerResult.currentRunId);
    if (ledgerChanged) {
      writeJson(ledgerPath(repoDir), ledgerResult.ledger);
    }
    storedSnapshot.snapshot = snapshot;
    writeJson(join(repoDir, "snapshot.json"), storedSnapshot);
    writeJson(join(repoDir, "hints.json"), {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      hints: snapshot.packageManager.hints,
      executionPlan: snapshot.executionPlan
    });
    return { ok: true, stateRoot: root, repoDir };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function attachReadOnlyCoordination(snapshot, options) {
  const root = stateRoot();
  const repoDir = join(root, "repos", snapshot.repo.hash);
  attachCoordination(snapshot, readLedger(repoDir), repoDir, options.runId);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = buildSnapshot(options.cwd);
  const stateWrite = options.writeState ? writeState(snapshot, options) : { ok: true, skipped: true };
  if (!snapshot.occupancy) attachReadOnlyCoordination(snapshot, options);
  console.log(JSON.stringify({ ok: true, snapshot, stateWrite }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exit(1);
}
