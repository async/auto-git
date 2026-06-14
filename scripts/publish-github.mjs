#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const GITHUB_REGISTRY = "https://npm.pkg.github.com";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const spec = `${manifest.name}@${manifest.version}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isMissingVersion(result) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(text);
}

const scope = manifest.name.match(/^@([^/]+)\//)?.[1]?.toLowerCase();
const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? scope ?? "").toLowerCase();
if (!scope || !owner || scope !== owner) {
  fail(`GitHub Packages requires the npm scope to match the repository owner. Package scope=${scope ?? "none"}, owner=${owner || "unknown"}.`);
}

const token = process.env.GITHUB_TOKEN ?? process.env.NODE_AUTH_TOKEN;
if (!token) {
  fail("Set GITHUB_TOKEN or NODE_AUTH_TOKEN with packages:write to publish to GitHub Packages.");
}

const stagingDir = await mkdtemp(join(tmpdir(), "auto-git-github-packages-"));
const npmConfig = join(stagingDir, ".npmrc");
await writeFile(
  npmConfig,
  `@${scope}:registry=${GITHUB_REGISTRY}\n//npm.pkg.github.com/:_authToken=${token}\n`,
  "utf8"
);
await chmod(npmConfig, 0o600);

function npm(args, options = {}) {
  return spawnSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: npmConfig
    }
  });
}

try {
  const view = npm(["view", spec, "version", "--registry", GITHUB_REGISTRY]);
  if (view.status === 0 && view.stdout.trim() === manifest.version) {
    console.log(`${spec} is already published to GitHub Packages; skipping publish.`);
  } else {
    if (!isMissingVersion(view)) {
      console.error(`${view.stdout ?? ""}${view.stderr ?? ""}`.slice(0, 2000));
      fail(`Could not determine whether ${spec} exists on GitHub Packages; refusing to guess.`);
    }
    console.log(`Publishing ${spec} to GitHub Packages.`);
    const publish = npm(["publish", "--tag", "latest", "--ignore-scripts", "--registry", GITHUB_REGISTRY], {
      inherit: true
    });
    if (publish.status !== 0) {
      process.exit(publish.status ?? 1);
    }
  }

  const tag = npm(["dist-tag", "add", spec, "latest", "--registry", GITHUB_REGISTRY], { inherit: true });
  process.exit(tag.status ?? 1);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
