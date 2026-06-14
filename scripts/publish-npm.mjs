#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REGISTRY = "https://registry.npmjs.org/";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const spec = `${manifest.name}@${manifest.version}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function npm(args, options = {}) {
  return spawnSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(repoRoot, ".async", "npm-cache")
    }
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function isMissingVersion(result) {
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(output(result));
}

function viewVersion() {
  return npm(["view", spec, "version", "--registry", REGISTRY]);
}

function hasPublishedVersion(result) {
  return result.status === 0 && result.stdout.trim() === manifest.version;
}

async function waitForPublishedVersion() {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const view = viewVersion();
    if (hasPublishedVersion(view)) {
      return true;
    }
    if (attempt < 8) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2000));
    }
  }
  return false;
}

if (manifest.private) {
  fail(`${manifest.name} is marked private; refusing to publish.`);
}

const view = viewVersion();
if (hasPublishedVersion(view)) {
  console.log(`${spec} is already published to npm; skipping.`);
  process.exit(0);
}
if (!isMissingVersion(view)) {
  console.error(output(view).slice(0, 2000));
  fail(`Could not determine whether ${spec} exists on npm; refusing to guess.`);
}

console.log(`Publishing ${spec} to npm with provenance.`);
const publish = npm(
  ["publish", "--access", "public", "--registry", REGISTRY, "--provenance"],
  { inherit: true }
);
if (publish.status === 0) {
  process.exit(0);
}

if (await waitForPublishedVersion()) {
  console.log(`${spec} appeared on npm after a publish race; treating as success.`);
  process.exit(0);
}

process.exit(publish.status ?? 1);
