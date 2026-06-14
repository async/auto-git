#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
    env: process.env
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function isMissingVersion(result) {
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(output(result));
}

if (manifest.private) {
  fail(`${manifest.name} is marked private; refusing to publish.`);
}

const view = npm(["view", spec, "version", "--registry", REGISTRY]);
if (view.status === 0 && view.stdout.trim() === manifest.version) {
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
process.exit(publish.status ?? 1);
