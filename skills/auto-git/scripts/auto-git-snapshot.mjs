#!/usr/bin/env node
import { createHash } from "node:crypto";
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

const SCHEMA_VERSION = 2;
const PACKAGE_MANAGER_HINT_THREAD = "019ebdd4-9cff-76c2-bf71-a3bb38ad1592";

function usage() {
  return [
    "Usage: auto-git-snapshot.mjs [--cwd <repo>] [--write-state]",
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
  if (
    parsed.recordVerification !== undefined &&
    /(?:TOKEN|SECRET|PASSWORD|AUTH|_authToken)\s*=/i.test(parsed.recordVerification)
  ) {
    throw new Error("Refusing to record a verification name that looks like it contains a secret assignment.");
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

function repoSlug(repoRoot) {
  return basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
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
    generatedAt: new Date().toISOString(),
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
    const updatedAt = new Date().toISOString();
    const storedSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      snapshot
    };
    writeJson(join(repoDir, "snapshot.json"), storedSnapshot);
    writeJson(join(repoDir, "hints.json"), {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      hints: snapshot.packageManager.hints,
      executionPlan: snapshot.executionPlan
    });

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
    }
    return { ok: true, stateRoot: root, repoDir };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = buildSnapshot(options.cwd);
  const stateWrite = options.writeState ? writeState(snapshot, options) : { ok: true, skipped: true };
  console.log(JSON.stringify({ ok: true, snapshot, stateWrite }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exit(1);
}
