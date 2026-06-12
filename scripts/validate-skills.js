#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir } from "./skill-packages.js";

const skillsDir = path.join(rootDir, "skills");
const skillNames = (await readdir(skillsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const issues = [];

for (const skillName of skillNames) {
  const skillDir = path.join(skillsDir, skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  const openaiPath = path.join(skillDir, "agents", "openai.yaml");

  if (!existsSync(skillPath)) {
    issues.push(`${skillName}: missing SKILL.md`);
    continue;
  }
  if (!existsSync(openaiPath)) {
    issues.push(`${skillName}: missing agents/openai.yaml`);
  }

  const skillContent = await readFile(skillPath, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillContent);
  if (!frontmatter) {
    issues.push(`${skillName}: missing YAML frontmatter`);
  } else {
    const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter[1]);
    const descriptionMatch = /^description:\s*(.+)$/m.exec(frontmatter[1]);
    const declaredName = nameMatch?.[1]?.trim().replace(/^"|"$/g, "");
    if (declaredName !== skillName) {
      issues.push(`${skillName}: frontmatter name must be ${skillName}`);
    }
    if (!descriptionMatch) {
      issues.push(`${skillName}: frontmatter description is required`);
    }
  }

  if (skillContent.includes("TODO")) {
    issues.push(`${skillName}: SKILL.md contains TODO`);
  }

  if (existsSync(openaiPath)) {
    const openai = await readFile(openaiPath, "utf8");
    if (!openai.includes(`$${skillName}`)) {
      issues.push(`${skillName}: agents/openai.yaml default_prompt must mention $${skillName}`);
    }
  }
}

const autoGitStylePath = path.join(skillsDir, "auto-git", "references", "commit-by-intent.md");
if (!existsSync(autoGitStylePath)) {
  issues.push("auto-git: missing canonical commit-by-intent reference");
}

for (const companion of ["git-intent-audit", "git-history-rewrite"]) {
  const content = await readFile(path.join(skillsDir, companion, "SKILL.md"), "utf8");
  if (!content.includes("Auto Git") || !content.includes("commit-by-intent")) {
    issues.push(`${companion}: must defer commit style to Auto Git commit-by-intent`);
  }
}

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exit(1);
}

console.log(`validated ${skillNames.length} skills`);
