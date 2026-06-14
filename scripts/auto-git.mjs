#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = new Map([
  ["start", { path: "skills/auto-git/scripts/auto-git-start.mjs", description: "claim an Auto Git run" }],
  ["snapshot", { path: "skills/auto-git/scripts/auto-git-snapshot.mjs", description: "inspect git topology" }],
  ["gate", { path: "skills/auto-git/scripts/auto-git-gate.mjs", description: "run a verification gate" }],
  ["ledger", { path: "skills/auto-git/scripts/auto-git-ledger.mjs", description: "read Auto Git ledger state" }],
  ["finish", { path: "skills/auto-git/scripts/auto-git-finish.mjs", description: "finish a coordinated run" }],
  [
    "release-preflight",
    { path: "skills/auto-git/scripts/auto-git-release-preflight.mjs", description: "check release tag readiness" }
  ],
  ["release-doctor", { path: "scripts/release-doctor.mjs", description: "check npm and GitHub release state" }]
]);

const ALIASES = new Map([
  ["auto-git-start", "start"],
  ["auto-git-start.mjs", "start"],
  ["auto-git-snapshot", "snapshot"],
  ["auto-git-snapshot.mjs", "snapshot"],
  ["auto-git-gate", "gate"],
  ["auto-git-gate.mjs", "gate"],
  ["auto-git-ledger", "ledger"],
  ["auto-git-ledger.mjs", "ledger"],
  ["auto-git-finish", "finish"],
  ["auto-git-finish.mjs", "finish"],
  ["auto-git-release-preflight", "release-preflight"],
  ["auto-git-release-preflight.mjs", "release-preflight"],
  ["auto-git-release-doctor", "release-doctor"],
  ["auto-git-release-doctor.mjs", "release-doctor"]
]);

function usage() {
  const commands = [...COMMANDS.entries()]
    .map(([name, command]) => `  ${name.padEnd(17)} ${command.description}`)
    .join("\n");
  return [
    "Usage: auto-git <command> [args...]",
    "",
    "Commands:",
    commands,
    "",
    "Examples:",
    "  auto-git snapshot --cwd \"$PWD\" --write-state",
    "  auto-git gate --cwd \"$PWD\" --profile auto -- pnpm run verify",
    "  auto-git release-preflight --cwd \"$PWD\" --require-verification"
  ].join("\n");
}

function normalizeCommand(value) {
  if (!value) return null;
  return ALIASES.get(value) ?? value;
}

function findSourceRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (isAutoGitSourceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isAutoGitSourceRoot(candidate) {
  const packageJsonPath = join(candidate, "package.json");
  const snapshotPath = join(candidate, "skills/auto-git/scripts/auto-git-snapshot.mjs");
  if (!existsSync(packageJsonPath) || !existsSync(snapshotPath)) return false;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return packageJson.name === "@async/auto-git";
  } catch {
    return false;
  }
}

function resolveHelper(commandName) {
  const command = COMMANDS.get(commandName);
  if (!command) return null;

  const explicitSourceRoot = process.env.AUTO_GIT_SOURCE_ROOT
    ? resolve(process.env.AUTO_GIT_SOURCE_ROOT)
    : null;
  const sourceRoot = explicitSourceRoot && isAutoGitSourceRoot(explicitSourceRoot)
    ? explicitSourceRoot
    : findSourceRoot(process.cwd());

  const sourceHelper = sourceRoot ? join(sourceRoot, command.path) : null;
  if (sourceHelper && existsSync(sourceHelper)) {
    return sourceHelper;
  }

  const packagedHelper = join(packageRoot, command.path);
  return existsSync(packagedHelper) ? packagedHelper : null;
}

const [rawCommand, ...args] = process.argv.slice(2);
const commandName = normalizeCommand(rawCommand);

if (!commandName || rawCommand === "--help" || rawCommand === "-h") {
  console.log(usage());
  process.exit(0);
}

if (!COMMANDS.has(commandName)) {
  console.error(`Unknown Auto Git command: ${rawCommand}`);
  console.error("");
  console.error(usage());
  process.exit(2);
}

const helper = resolveHelper(commandName);
if (!helper) {
  console.error(`Auto Git helper is unavailable for command: ${commandName}`);
  process.exit(127);
}

const result = spawnSync(process.execPath, [helper, ...args], {
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
