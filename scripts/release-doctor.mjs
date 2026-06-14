#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const GITHUB_REGISTRY = "https://npm.pkg.github.com";

const args = process.argv.slice(2);
const mode = args.includes("--repair") ? "repair" : "check";
const json = args.includes("--json");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const name = manifest.name;
const version = manifest.version;
const tag = `v${version}`;

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(process.cwd(), ".async", "npm-cache"),
      ...(options.env ?? {})
    }
  });
}

function text(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function okResult(result) {
  return { known: true, ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function missingFromNpm(result) {
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(text(result));
}

function npmView(registry, token) {
  let stagingDir;
  let env = process.env;
  const scope = name.match(/^@([^/]+)\//)?.[1];
  if (registry === GITHUB_REGISTRY) {
    if (!token || !scope) return { known: false, reason: "missing GITHUB_TOKEN for GitHub Packages lookup" };
    stagingDir = mkdtempSync(join(tmpdir(), "auto-git-release-doctor-"));
    const npmConfig = join(stagingDir, ".npmrc");
    writeFileSync(npmConfig, `@${scope}:registry=${GITHUB_REGISTRY}\n//npm.pkg.github.com/:_authToken=${token}\n`);
    chmodSync(npmConfig, 0o600);
    env = { ...process.env, NPM_CONFIG_USERCONFIG: npmConfig };
  }
  try {
    const result = run("npm", ["view", `${name}@${version}`, "version", "--registry", registry], { env });
    if (result.status === 0) return { known: true, exists: true, version: result.stdout.trim() };
    if (missingFromNpm(result)) return { known: true, exists: false };
    return { known: false, reason: text(result) || `npm view failed for ${registry}` };
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function gitTag(ref) {
  const result = run("git", ["rev-parse", "-q", "--verify", ref]);
  if (result.status !== 0) return { known: true, exists: false };
  return { known: true, exists: true, commit: result.stdout.trim() };
}

function remoteTag() {
  const result = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}^{}`]);
  if (result.status !== 0) return { known: false, reason: text(result) || "git ls-remote failed" };
  const line = result.stdout.trim().split("\n").filter(Boolean)[0];
  return line ? { known: true, exists: true, commit: line.split(/\s+/)[0] } : { known: true, exists: false };
}

function githubRelease() {
  const result = run("gh", ["release", "view", tag, "--json", "url,tagName,isDraft,isPrerelease,targetCommitish"]);
  if (result.status === 0) return { known: true, exists: true, details: JSON.parse(result.stdout) };
  if (/not found/i.test(text(result))) return { known: true, exists: false };
  return { known: false, reason: text(result) || "gh release view failed" };
}

function workflowStatus(commit) {
  if (!commit) return { known: false, reason: "no tag commit for workflow lookup" };
  const result = run("gh", [
    "run",
    "list",
    "--commit",
    commit,
    "--limit",
    "10",
    "--json",
    "databaseId,workflowName,status,conclusion,url,createdAt"
  ]);
  if (result.status !== 0) return { known: false, reason: text(result) || "gh run list failed" };
  const runs = JSON.parse(result.stdout || "[]").filter((run) => run.workflowName === "Async Pipeline");
  return {
    known: true,
    exists: runs.length > 0,
    latest: runs[0]
      ? {
          databaseId: runs[0].databaseId,
          status: runs[0].status,
          conclusion: runs[0].conclusion,
          url: runs[0].url,
          createdAt: runs[0].createdAt
        }
      : undefined
  };
}

function packageVersionAt(ref) {
  const result = run("git", ["show", `${ref}:package.json`]);
  if (result.status !== 0) return { known: false, reason: text(result) || `cannot read package.json at ${ref}` };
  try {
    return { known: true, version: JSON.parse(result.stdout).version };
  } catch {
    return { known: false, reason: `package.json at ${ref} is not valid JSON` };
  }
}

function collectFacts() {
  if (process.env.AUTO_GIT_RELEASE_DOCTOR_FACTS) {
    return JSON.parse(process.env.AUTO_GIT_RELEASE_DOCTOR_FACTS);
  }

  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const localTag = gitTag(`refs/tags/${tag}^{commit}`);
  const remote = remoteTag();
  const tagCommit = localTag.exists ? localTag.commit : remote.exists ? remote.commit : undefined;
  return {
    package: { name, version, private: Boolean(manifest.private) },
    head,
    tag,
    localTag,
    remoteTag: remote,
    npm: npmView(NPM_REGISTRY),
    githubPackage: npmView(GITHUB_REGISTRY, process.env.GITHUB_TOKEN ?? process.env.NODE_AUTH_TOKEN),
    githubRelease: githubRelease(),
    workflow: workflowStatus(tagCommit),
    taggedPackage: tagCommit ? packageVersionAt(tagCommit) : { known: true, version: undefined }
  };
}

function evaluate(facts) {
  const actions = [];
  const problems = [];
  const unknowns = [];
  const localTag = facts.localTag ?? { known: true, exists: false };
  const remoteTag = facts.remoteTag ?? { known: true, exists: false };
  const tagCommit = localTag.commit ?? remoteTag.commit;
  const head = facts.head;

  for (const [label, value] of [
    ["remote tag", remoteTag],
    ["npm", facts.npm],
    ["GitHub Packages", facts.githubPackage],
    ["GitHub Release", facts.githubRelease],
    ["workflow", facts.workflow],
    ["tagged package", facts.taggedPackage]
  ]) {
    if (value?.known === false) unknowns.push(`${label}: ${value.reason ?? "unknown"}`);
  }

  if (facts.package?.private) problems.push(`${facts.package.name} is marked private`);
  if (facts.taggedPackage?.version && facts.taggedPackage.version !== facts.package.version) {
    problems.push(`tag ${facts.tag} package version is ${facts.taggedPackage.version}, not ${facts.package.version}`);
  }
  if (!localTag.exists && !remoteTag.exists) {
    problems.push(`tag ${facts.tag} is missing locally and remotely`);
  }
  if (localTag.exists && !remoteTag.exists) actions.push({ id: "push-tag", label: `push local tag ${facts.tag} to origin` });
  if (!localTag.exists && remoteTag.exists) actions.push({ id: "fetch-tag", label: `fetch remote tag ${facts.tag}` });

  if (facts.npm?.known && !facts.npm.exists) {
    if (localTag.exists && head === localTag.commit) actions.push({ id: "publish-npm", label: `publish ${facts.package.name}@${facts.package.version} to npm` });
    else problems.push(`npm is missing ${facts.package.name}@${facts.package.version}; publish from the tagged commit ${tagCommit ?? facts.tag}`);
  }
  if (facts.githubPackage?.known && !facts.githubPackage.exists) {
    if (localTag.exists && head === localTag.commit) actions.push({ id: "publish-github", label: `publish ${facts.package.name}@${facts.package.version} to GitHub Packages` });
    else problems.push(`GitHub Packages is missing ${facts.package.name}@${facts.package.version}; publish from the tagged commit ${tagCommit ?? facts.tag}`);
  }
  if (facts.githubRelease?.known && !facts.githubRelease.exists && (localTag.exists || remoteTag.exists)) {
    actions.push({ id: "create-release", label: `create GitHub Release ${facts.tag}` });
  }
  if (facts.workflow?.known && facts.workflow.exists && facts.workflow.latest?.conclusion && facts.workflow.latest.conclusion !== "success") {
    problems.push(`latest Async Pipeline run for ${tagCommit ?? facts.tag} concluded ${facts.workflow.latest.conclusion}`);
  }

  return {
    healthy: unknowns.length === 0 && problems.length === 0 && actions.length === 0,
    repairable: unknowns.length === 0 && problems.length === 0 && actions.length > 0,
    unknowns,
    actions,
    problems
  };
}

function applyAction(action) {
  if (action.id === "push-tag") return run("git", ["push", "origin", tag], { inherit: true }).status === 0;
  if (action.id === "fetch-tag") return run("git", ["fetch", "origin", "tag", tag], { inherit: true }).status === 0;
  if (action.id === "publish-npm") return run("pnpm", ["async-pipeline", "publish", "npm", "--package", "."], { inherit: true }).status === 0;
  if (action.id === "publish-github") return run("pnpm", ["async-pipeline", "publish", "github", "release", "--package", "."], { inherit: true }).status === 0;
  if (action.id === "create-release") return run("gh", ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", tag], { inherit: true }).status === 0;
  return false;
}

const facts = collectFacts();
const result = evaluate(facts);
const applied = [];
if (mode === "repair" && result.repairable && !process.env.AUTO_GIT_RELEASE_DOCTOR_FACTS) {
  for (const action of result.actions) {
    const ok = applyAction(action);
    applied.push({ ...action, ok });
    if (!ok) result.problems.push(`repair failed: ${action.label}`);
  }
}

const receipt = {
  schemaVersion: 1,
  tool: "release-doctor",
  mode,
  ok: result.healthy || (mode === "repair" && applied.length > 0 && applied.every((entry) => entry.ok) && result.problems.length === 0),
  healthy: result.healthy,
  repairable: result.repairable,
  package: facts.package,
  tag: facts.tag,
  facts,
  actions: result.actions,
  applied,
  unknowns: result.unknowns,
  problems: result.problems
};

if (json) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`Release doctor for ${name}@${version}`);
  console.log(`healthy: ${receipt.healthy}`);
  for (const action of result.actions) console.log(`repairable: ${action.label}`);
  for (const unknown of result.unknowns) console.log(`unknown: ${unknown}`);
  for (const problem of result.problems) console.log(`problem: ${problem}`);
}

if (receipt.ok) process.exit(0);
if (result.unknowns.length > 0) process.exit(2);
if (result.problems.length > 0) process.exit(3);
process.exit(1);
