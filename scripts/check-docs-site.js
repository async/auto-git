#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../docs/index.md", import.meta.url), "utf8");

if (!/^# Auto Git/m.test(index)) {
  console.error("docs/index.md must start the GitHub Pages site with an Auto Git heading.");
  process.exit(1);
}
