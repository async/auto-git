#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const snapshotScript = join(scriptDir, "auto-git-snapshot.mjs");

function usage() {
  return [
    "Usage: auto-git-gate.mjs --cwd <repo> [--profile auto|default|loopback-capable]",
    "       [--quiet-seconds <n>] [--timeout-ms <n>] -- <command> [args...]",
    "",
    "Runs a verification gate with bounded Auto Git process tracking and emits a compact receipt."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    profile: "auto",
    quietSeconds: 60,
    timeoutMs: 0,
    command: []
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      parsed.command = argv.slice(index + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--cwd") {
      parsed.cwd = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--profile") {
      parsed.profile = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--quiet-seconds") {
      parsed.quietSeconds = Number(requireValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requireValue(argv, ++index, arg));
      continue;
    }
    throw new Error(`Unknown argument before --: ${arg}`);
  }

  if (parsed.command.length === 0) {
    throw new Error("A command is required after --.");
  }
  if (!Number.isFinite(parsed.quietSeconds) || parsed.quietSeconds < 0) {
    throw new Error("--quiet-seconds must be a non-negative number.");
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 0) {
    throw new Error("--timeout-ms must be a non-negative number.");
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

function runSnapshot(cwd) {
  const result = spawnSync(process.execPath, [snapshotScript, "--cwd", cwd, "--write-state"], {
    encoding: "utf8"
  });
  const payload = parseJsonOutput(result.stdout || result.stderr);
  if (!payload?.ok) {
    throw new Error(payload?.error || `snapshot failed with status ${result.status}`);
  }
  return payload;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function stateRoot() {
  return process.env.AUTO_GIT_STATE_HOME || join(homedir(), ".async", "auto-git", "v1");
}

function repoStateDir(snapshot) {
  return join(stateRoot(), "repos", snapshot.repo.hash);
}

function writeJsonSoft(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function recordProcess(snapshot, entry) {
  const path = join(repoStateDir(snapshot), "processes.json");
  let existing = { schemaVersion: SCHEMA_VERSION, entries: [] };
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or unreadable process state should not block gate execution.
  }
  const entries = [entry, ...(existing.entries ?? [])].slice(0, 50);
  return writeJsonSoft(path, { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), entries });
}

function sha256(value, length = 32) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function commandName(command) {
  return command.join(" ");
}

function chooseProfile(options, snapshotPayload) {
  if (options.profile !== "auto") return options.profile;
  const planned = snapshotPayload.snapshot.executionPlan.verification;
  if (!planned) return "default";
  const requested = commandName(options.command);
  if (requested === planned.name || requested === commandName(planned.command ?? [])) {
    return planned.executionProfile ?? "default";
  }
  return "default";
}

function envForProfile(profile, snapshotPayload) {
  const planned = snapshotPayload.snapshot.executionPlan.verification;
  if (planned?.executionProfile === profile) {
    return planned.env ?? {};
  }
  return {};
}

function inspectProcessGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const fixture = readJsonEnv("AUTO_GIT_PROCESS_TREE_FIXTURE");
  if (Array.isArray(fixture)) return fixture.map(summarizeProcess).filter(Boolean).slice(0, 30);

  const result = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid=,stat=,comm="], {
    encoding: "utf8"
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseProcessLine)
    .filter((processInfo) => processInfo?.pgid === pgid)
    .map(summarizeProcess)
    .slice(0, 30);
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

function parseProcessLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 5) return undefined;
  const [pid, ppid, pgid, stat, command] = parts;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    stat,
    command
  };
}

function summarizeProcess(processInfo) {
  if (!processInfo || !Number.isInteger(Number(processInfo.pid))) return undefined;
  return {
    pid: Number(processInfo.pid),
    ppid: Number.isInteger(Number(processInfo.ppid)) ? Number(processInfo.ppid) : undefined,
    pgid: Number.isInteger(Number(processInfo.pgid)) ? Number(processInfo.pgid) : undefined,
    stat: typeof processInfo.stat === "string" ? processInfo.stat : undefined,
    command: typeof processInfo.command === "string" ? basename(processInfo.command) : undefined
  };
}

function classifyFailure(exitCode, signal, timedOut, output, diagnostics) {
  if (exitCode === 0) return "passed";
  if (timedOut) return "hung";
  if (signal === "SIGINT" || signal === "SIGTERM") return "interrupted";

  const text = output.toLowerCase();
  const environmentPatterns = [
    /listen\s+eperm\s+127\.0\.0\.1/i,
    /operation not permitted.*(?:npm|logs?|cache|index\.lock|\.git)/i,
    /permission denied.*(?:npm|logs?|cache|index\.lock|\.git)/i,
    /could not create.*index\.lock/i,
    /npm err!.*logs? were not written/i,
    /\.async\/run\.lock/i,
    /eacces.*(?:npm|cache|logs?)/i,
    /eperm.*(?:npm|cache|logs?|127\.0\.0\.1)/i
  ];
  if (environmentPatterns.some((pattern) => pattern.test(output))) return "environment-failure";
  if (diagnostics.some((diagnostic) => diagnostic.kind === "quiet-process-tree")) return "hung";
  return "code-failure";
}

function tailLines(lines, count = 20) {
  return lines.slice(Math.max(0, lines.length - count));
}

function recordVerification(snapshotPayload, options, exitCode, profile, durationMs, failureClass) {
  const args = [
    snapshotScript,
    "--cwd",
    options.cwd,
    "--write-state",
    "--record-verification",
    commandName(options.command),
    "--exit-code",
    String(exitCode ?? 1),
    "--execution-profile",
    profile,
    "--duration-ms",
    String(durationMs),
    "--failure-class",
    failureClass
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const payload = parseJsonOutput(result.stdout || result.stderr);
  return payload?.stateWrite ?? { ok: false, reason: "verification state write did not return JSON" };
}

function terminateProcessGroup(child) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, "SIGTERM");
    return true;
  } catch {
    try {
      child.kill("SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

async function runGate(options) {
  const snapshotPayload = runSnapshot(options.cwd);
  const snapshot = snapshotPayload.snapshot;
  const profile = chooseProfile(options, snapshotPayload);
  const envOverrides = envForProfile(profile, snapshotPayload);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const command = options.command;
  const commandId = sha256(JSON.stringify({ cwd: options.cwd, command, startedAt }));

  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...envOverrides },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const processEntry = {
    id: commandId,
    startedAt,
    command,
    executionProfile: profile,
    pid: child.pid,
    pgid: child.pid,
    dirtyFingerprint: snapshot.dirty.fingerprint
  };
  const processStateWrite = recordProcess(snapshot, processEntry);

  const stdoutLines = [];
  const stderrLines = [];
  const diagnostics = [];
  let lastOutputAt = Date.now();
  let quietDiagnosticEmitted = false;
  let timedOut = false;

  child.stdout.on("data", (chunk) => {
    lastOutputAt = Date.now();
    stdoutLines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
  });
  child.stderr.on("data", (chunk) => {
    lastOutputAt = Date.now();
    stderrLines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
  });

  const quietMs = options.quietSeconds * 1000;
  const quietInterval =
    quietMs > 0
      ? setInterval(() => {
          if (quietDiagnosticEmitted || Date.now() - lastOutputAt < quietMs) return;
          quietDiagnosticEmitted = true;
          diagnostics.push({
            kind: "quiet-process-tree",
            afterMs: Date.now() - lastOutputAt,
            processTree: inspectProcessGroup(child.pid)
          });
        }, Math.max(250, Math.min(quietMs, 5000)))
      : undefined;

  const timeout =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          diagnostics.push({
            kind: "timeout-process-tree",
            afterMs: options.timeoutMs,
            processTree: inspectProcessGroup(child.pid)
          });
          terminateProcessGroup(child);
        }, options.timeoutMs)
      : undefined;

  const result = await new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ exitCode: 1, signal: undefined, spawnError: String(error?.message ?? error) });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

  if (quietInterval) clearInterval(quietInterval);
  if (timeout) clearTimeout(timeout);

  const durationMs = Date.now() - startMs;
  const outputForClassification = [...stdoutLines, ...stderrLines, result.spawnError ?? ""].join("\n");
  const failureClass = classifyFailure(result.exitCode, result.signal, timedOut, outputForClassification, diagnostics);
  const verificationStateWrite = recordVerification(
    snapshotPayload,
    options,
    result.exitCode,
    profile,
    durationMs,
    failureClass
  );

  return {
    ok: result.exitCode === 0,
    schemaVersion: SCHEMA_VERSION,
    command,
    cwd: options.cwd,
    executionProfile: profile,
    envOverrides,
    pid: child.pid,
    pgid: child.pid,
    startedAt,
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    failureClass,
    diagnostics,
    stdoutTail: tailLines(stdoutLines),
    stderrTail: tailLines(stderrLines),
    stateWrite: {
      snapshot: snapshotPayload.stateWrite,
      process: processStateWrite,
      verification: verificationStateWrite
    }
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await runGate(options);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exit(1);
}
