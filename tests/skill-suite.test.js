import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expectedGistFiles, readManifest, rootDir } from "../scripts/skill-packages.js";

test("manifest packages every skill into flat gist files", async () => {
  const manifest = await readManifest();
  assert.deepEqual(
    manifest.skills.map((skill) => skill.name).sort(),
    ["auto-git", "git-history-rewrite", "git-intent-audit"]
  );

  for (const skill of manifest.skills) {
    const files = await expectedGistFiles(skill);
    assert.ok(files.has("README.md"), `${skill.name} packages README.md`);
    assert.ok(files.has(`${skill.name}.SKILL.md`), `${skill.name} packages SKILL.md`);
    assert.ok(files.has(`${skill.name}.openai.yaml`), `${skill.name} packages openai.yaml`);
  }
});

test("companion skills use Auto Git as commit-style source", async () => {
  const audit = await readFile(path.join(rootDir, "skills/git-intent-audit/SKILL.md"), "utf8");
  const rewrite = await readFile(path.join(rootDir, "skills/git-history-rewrite/SKILL.md"), "utf8");
  assert.match(audit, /Auto Git's commit style as the source of truth/);
  assert.match(rewrite, /using Auto Git's commit-by-intent style/);
});

test("history rewrite safety recipe preserves final tree and co-author trailer", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "auto-git-history-"));
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Codex Tester"]);
    git(repo, ["config", "user.email", "codex@example.com"]);

    await writeProjectFile(repo, "src/app.js", "export const value = 'v1';\n");
    commit(repo, "chore(repo): initial fixture", "Setup <setup@example.com>");

    git(repo, ["switch", "-c", "feature/messy"]);
    await writeProjectFile(repo, "src/app.js", "export const value = 'v2';\n");
    await writeProjectFile(repo, "docs/app.md", "# App\n\nv2\n");
    commit(repo, "docs(app): update app docs", "Alice <alice@example.com>");

    await writeProjectFile(repo, "tests/app.test.js", "import { value } from '../src/app.js';\nassert.equal(value, 'v2');\n");
    commit(repo, "update tests", "Bob <bob@example.com>");

    const oldHead = git(repo, ["rev-parse", "HEAD"]);
    const base = git(repo, ["merge-base", "main", "HEAD"]);
    git(repo, ["branch", "backup/feature-messy-before-history-rewrite-test", oldHead]);
    git(repo, ["switch", "-c", "rewrite/feature-messy-by-intent-test", base]);

    git(repo, ["checkout", oldHead, "--", "src/app.js", "tests/app.test.js"]);
    git(repo, ["add", "src/app.js", "tests/app.test.js"]);
    git(repo, [
      "commit",
      "--author",
      "Alice <alice@example.com>",
      "-m",
      "fix(app): update runtime value",
      "-m",
      "Original-commits:\n- runtime/docs source commit\n- test source commit\n\nCo-authored-by: Bob <bob@example.com>"
    ]);

    git(repo, ["checkout", oldHead, "--", "docs/app.md"]);
    git(repo, ["add", "docs/app.md"]);
    git(repo, ["commit", "--author", "Alice <alice@example.com>", "-m", "docs(app): document updated value"]);

    git(repo, ["diff", "--quiet", oldHead, "HEAD"]);
    const body = git(repo, ["log", "--format=%B", "--max-count=2"]);
    assert.match(body, /Co-authored-by: Bob <bob@example.com>/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function writeProjectFile(repo, filePath, content) {
  await mkdir(path.dirname(path.join(repo, filePath)), { recursive: true });
  await writeFile(path.join(repo, filePath), content);
}

function commit(repo, message, author) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--author", author, "-m", message]);
}
