#!/usr/bin/env node
import { expectedGistFiles, readManifest } from "./skill-packages.js";

const token = process.env.GIST_TOKEN;
if (!token) {
  console.error("GIST_TOKEN is required to publish gist packages");
  process.exit(1);
}

const manifest = await readManifest();

for (const skill of manifest.skills) {
  const expected = await expectedGistFiles(skill);
  const currentResponse = await fetch(`https://api.github.com/gists/${skill.gistId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "async-auto-git"
    }
  });

  if (!currentResponse.ok) {
    throw new Error(`Failed to read gist ${skill.gistId}: HTTP ${currentResponse.status}`);
  }

  const current = await currentResponse.json();
  const files = {};
  for (const fileName of Object.keys(current.files ?? {})) {
    if (!expected.has(fileName)) {
      files[fileName] = null;
    }
  }
  for (const [fileName, content] of expected) {
    files[fileName] = { content };
  }

  const updateResponse = await fetch(`https://api.github.com/gists/${skill.gistId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "async-auto-git"
    },
    body: JSON.stringify({
      description: skill.description,
      files
    })
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update gist ${skill.gistId}: HTTP ${updateResponse.status}`);
  }

  console.log(`updated ${skill.name} gist ${skill.gistId}`);
}
