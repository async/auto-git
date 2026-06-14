#!/usr/bin/env node
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

const copyEntries = [
  "bin",
  "scripts/auto-git.mjs",
  "scripts/release-doctor.mjs",
  "skills",
  "docs/gists",
  "gists",
  "gist-manifest.json",
  "api-contract.json",
  "API_SURFACE.md"
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of copyEntries) {
  await cp(new URL(`../${entry}`, import.meta.url), new URL(`../dist/${entry}`, import.meta.url), {
    recursive: true
  });
}

for (const bin of [
  "auto-git.js",
  "auto-git-finish.js",
  "auto-git-gate.js",
  "auto-git-ledger.js",
  "auto-git-release-doctor.js",
  "auto-git-release-preflight.js",
  "auto-git-snapshot.js",
  "auto-git-start.js"
]) {
  await chmod(join(root.pathname, "dist", "bin", bin), 0o755);
}
