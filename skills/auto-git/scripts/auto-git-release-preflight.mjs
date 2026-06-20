#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SNAPSHOT_SCRIPT = new URL("./auto-git-snapshot.mjs", import.meta.url);

function usage() {
  return [
    "Usage: auto-git-release-preflight.mjs [--cwd <repo>] [--version <semver>]",
    "       [--tag-prefix <prefix>] [--run-id <id>] [--require-verification] [--check-remote] [--json]",
    "",
    "Checks release metadata before creating or pushing a release tag."
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    cwd: process.cwd(),
    version: undefined,
    tagPrefix: "v",
    runId: undefined,
    requireVerification: false,
    checkRemote: false,
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
    if (arg === "--version") {
      parsed.version = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--tag-prefix") {
      parsed.tagPrefix = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--run-id") {
      parsed.runId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--require-verification") {
      parsed.requireVerification = true;
      continue;
    }
    if (arg === "--check-remote") {
      parsed.checkRemote = true;
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
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
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

function runSnapshotMutation(args) {
  const result = spawnSync(process.execPath, [SNAPSHOT_SCRIPT.pathname, ...args], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) return { ok: false, reason: result.stderr || result.stdout || `snapshot exited ${result.status}` };
  try {
    const payload = JSON.parse(result.stdout);
    return payload.stateWrite ?? { ok: false, reason: "snapshot mutation did not return stateWrite" };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tryReadJson(path, fallback) {
  try {
    return readJson(path);
  } catch {
    return fallback;
  }
}

function sha256(value, length = 64) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stateRoot() {
  return process.env.AUTO_GIT_STATE_HOME || join(homedir(), ".async", "auto-git", "v1");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverReleaseNotes(repoRoot) {
  const candidates = ["CHANGELOG.md", "RELEASE_NOTES.md", "RELEASES.md"];
  return candidates.find((file) => existsSync(join(repoRoot, file)));
}

function matchingVerification(snapshot) {
  const repoDir = join(stateRoot(), "repos", snapshot.repo.hash || sha256(snapshot.repo.root, 24));
  const verifications = tryReadJson(join(repoDir, "verifications.json"), { entries: [] });
  const entries = Array.isArray(verifications.entries) ? verifications.entries : [];
  const isReusable = (entry) =>
    entry.exitCode === 0 &&
    entry.head === snapshot.topology.head &&
    /(?:release|verify|check|test)/i.test(entry.name ?? "");
  const exact = entries.find(
    (entry) =>
      isReusable(entry) &&
      entry.dirtyFingerprint === snapshot.dirty.fingerprint &&
      /(?:release|verify|check|test)/i.test(entry.name ?? "")
  );
  if (exact) return { ...exact, matchType: "exact" };

  const cleanSameHead = entries.find((entry) => isReusable(entry) && !snapshot.dirty.isDirty);
  return cleanSameHead ? { ...cleanSameHead, matchType: "clean-same-head" } : undefined;
}

function tagStatus(repoRoot, tagName, head) {
  const local = git(repoRoot, ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`]);
  if (local.status === 0) {
    const sha = local.stdout.trim();
    return { exists: true, sha, matchesHead: sha === head };
  }
  return { exists: false };
}

function remoteTagStatus(repoRoot, tagName) {
  const remote = git(repoRoot, ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`]);
  if (remote.status !== 0) {
    return { checked: true, ok: false, warning: remote.stderr.trim() || "git ls-remote failed" };
  }
  const line = remote.stdout.trim().split("\n").filter(Boolean)[0];
  return line ? { checked: true, ok: true, exists: true, sha: line.split(/\s+/)[0] } : { checked: true, ok: true, exists: false };
}

function githubReleaseStatus(repoRoot, tagName) {
  const gh = spawnSync("gh", ["release", "view", tagName, "--json", "url,isDraft,isPrerelease,tagName,targetCommitish"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (gh.status === 0) {
    return { checked: true, exists: true, details: JSON.parse(gh.stdout) };
  }
  return { checked: true, exists: false, warning: gh.stderr.trim() || "gh release view failed" };
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

function recordPreflightEvidence(repoRoot, snapshot, options, tagName, version, safeToTag) {
  if (!safeToTag) return { ok: false, skipped: true, reason: "preflight did not pass" };
  const run = currentRun(snapshot, options.runId);
  if (!run?.id) return { ok: false, skipped: true, reason: "no Auto Git run resolved for release-preflight evidence" };
  const args = [
    "--cwd",
    repoRoot,
    "--write-state",
    "--record-release-preflight",
    run.id
  ];
  if (version) args.push("--release-version", version);
  if (tagName) args.push("--release-tag", tagName);
  return runSnapshotMutation(args);
}

function buildReceipt(options) {
  const repoRoot = resolve(options.cwd);
  const snapshot = runSnapshot(repoRoot);
  const blockers = [];
  const warnings = [];
  const packagePath = join(repoRoot, "package.json");
  const packageJson = existsSync(packagePath) ? readJson(packagePath) : undefined;
  const version = options.version ?? packageJson?.version;

  if (!packageJson) blockers.push("package.json is missing");
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    blockers.push("release version is missing or not semver");
  }

  const releaseNotesFile = discoverReleaseNotes(repoRoot);
  let releaseNotesMatch = false;
  if (!releaseNotesFile) {
    blockers.push("no changelog or release notes file found");
  } else if (version) {
    const releaseNotes = readFileSync(join(repoRoot, releaseNotesFile), "utf8");
    releaseNotesMatch = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s|-|$)`, "m").test(releaseNotes);
    if (!releaseNotesMatch) blockers.push(`${releaseNotesFile} has no section for ${version}`);
  }

  if (snapshot.dirty.isDirty) {
    blockers.push("worktree is dirty; tag only the exact committed release HEAD");
  }

  const verification = matchingVerification(snapshot);
  if (options.requireVerification && !verification) {
    blockers.push("no matching successful release/verify/check/test evidence for current HEAD");
  } else if (!verification) {
    warnings.push("no matching successful verification evidence recorded for current HEAD");
  }

  const tagName = version ? `${options.tagPrefix}${version}` : undefined;
  const localTag = tagName ? tagStatus(repoRoot, tagName, snapshot.topology.head) : { exists: false };
  if (localTag.exists) {
    blockers.push(
      localTag.matchesHead
        ? `local tag ${tagName} already exists at HEAD`
        : `local tag ${tagName} points at ${localTag.sha}, not current HEAD ${snapshot.topology.head}`
    );
  }

  const remoteTag = options.checkRemote && tagName ? remoteTagStatus(repoRoot, tagName) : { checked: false };
  if (remoteTag.exists) blockers.push(`remote tag ${tagName} already exists at ${remoteTag.sha}`);
  if (remoteTag.warning) warnings.push(remoteTag.warning);

  const githubRelease = options.checkRemote && tagName ? githubReleaseStatus(repoRoot, tagName) : { checked: false };
  if (githubRelease.exists) blockers.push(`GitHub Release ${tagName} already exists`);
  if (githubRelease.warning) warnings.push(githubRelease.warning);

  const safeToTag = blockers.length === 0;
  const evidenceStateWrite = recordPreflightEvidence(repoRoot, snapshot, options, tagName, version, safeToTag);
  if (safeToTag && evidenceStateWrite.ok === false && !evidenceStateWrite.skipped) {
    warnings.push(`release-preflight evidence was not recorded: ${evidenceStateWrite.reason ?? "unknown error"}`);
  }

  return {
    schemaVersion: 1,
    tool: "auto-git-release-preflight",
    ok: safeToTag,
    safeToTag,
    blockers,
    warnings,
    evidenceStateWrite,
    repo: {
      root: snapshot.repo.root,
      branch: snapshot.topology.branch,
      head: snapshot.topology.head,
      dirty: snapshot.dirty.isDirty
    },
    package: packageJson
      ? {
          name: packageJson.name,
          version,
          file: basename(packagePath)
        }
      : undefined,
    releaseNotes: {
      file: releaseNotesFile,
      hasMatchingSection: releaseNotesMatch
    },
    verification: verification
      ? {
          name: verification.name,
          matchType: verification.matchType,
          recordedAt: verification.recordedAt,
          head: verification.head
        }
      : undefined,
    tag: {
      name: tagName,
      local: localTag,
      remote: remoteTag,
      githubRelease
    }
  };
}

function printText(receipt) {
  console.log(`safeToTag: ${receipt.safeToTag}`);
  console.log(`version: ${receipt.package?.version ?? "unknown"}`);
  console.log(`tag: ${receipt.tag.name ?? "unknown"}`);
  if (receipt.blockers.length > 0) {
    console.log("blockers:");
    for (const blocker of receipt.blockers) console.log(`- ${blocker}`);
  }
  if (receipt.warnings.length > 0) {
    console.log("warnings:");
    for (const warning of receipt.warnings) console.log(`- ${warning}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const receipt = buildReceipt(options);
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else printText(receipt);
  if (!receipt.safeToTag) process.exit(1);
} catch (error) {
  const payload = {
    schemaVersion: 1,
    tool: "auto-git-release-preflight",
    ok: false,
    safeToTag: false,
    error: String(error?.message ?? error)
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
