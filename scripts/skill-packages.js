import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const rootDir = new URL("..", import.meta.url).pathname;
export const manifestPath = path.join(rootDir, "gist-manifest.json");

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readManifest() {
  const manifest = await readJson(manifestPath);
  if (!Array.isArray(manifest.skills)) {
    throw new Error("gist-manifest.json must contain a skills array");
  }
  return manifest;
}

export async function expectedGistFiles(skill) {
  const skillDir = path.join(rootDir, "skills", skill.name);
  const files = new Map();
  files.set("README.md", await readFile(path.join(rootDir, skill.readme), "utf8"));
  files.set(`${skill.name}.SKILL.md`, await readFile(path.join(skillDir, "SKILL.md"), "utf8"));
  files.set(`${skill.name}.openai.yaml`, await readFile(path.join(skillDir, "agents", "openai.yaml"), "utf8"));

  const referencesDir = path.join(skillDir, "references");
  if (existsSync(referencesDir)) {
    const references = (await readdir(referencesDir))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    for (const reference of references) {
      const baseName = reference.replace(/\.md$/, "");
      files.set(
        `${skill.name}.reference-${baseName}.md`,
        await readFile(path.join(referencesDir, reference), "utf8")
      );
    }
  }

  return files;
}

export async function writeGistPackage(skill) {
  const outputDir = path.join(rootDir, "gists", skill.name);
  const files = await expectedGistFiles(skill);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const [fileName, content] of files) {
    await writeFile(path.join(outputDir, fileName), content);
  }
}

export async function checkGistPackage(skill) {
  const outputDir = path.join(rootDir, "gists", skill.name);
  const expected = await expectedGistFiles(skill);
  const actualNames = existsSync(outputDir)
    ? (await readdir(outputDir)).filter((entry) => !entry.startsWith(".")).sort()
    : [];
  const expectedNames = [...expected.keys()].sort();
  const issues = [];

  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    issues.push(`${skill.name}: expected files ${expectedNames.join(", ")} but found ${actualNames.join(", ")}`);
  }

  for (const [fileName, expectedContent] of expected) {
    const filePath = path.join(outputDir, fileName);
    if (!existsSync(filePath)) continue;
    const actualContent = await readFile(filePath, "utf8");
    if (actualContent !== expectedContent) {
      issues.push(`${skill.name}: ${fileName} is stale; run pnpm gists:package`);
    }
  }

  return issues;
}
