#!/usr/bin/env node
import { checkGistPackage, readManifest, writeGistPackage } from "./skill-packages.js";

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("Usage: node scripts/package-gists.js --write|--check");
  process.exit(2);
}

const manifest = await readManifest();

if (mode === "write") {
  for (const skill of manifest.skills) {
    await writeGistPackage(skill);
    console.log(`wrote gists/${skill.name}`);
  }
} else {
  const issues = [];
  for (const skill of manifest.skills) {
    issues.push(...await checkGistPackage(skill));
  }
  if (issues.length > 0) {
    console.error(issues.join("\n"));
    process.exit(1);
  }
  console.log("gist packages are current");
}
