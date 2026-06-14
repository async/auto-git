#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const site = {
  "title": "@async/auto-git",
  "repo": "auto-git",
  "stage": "Beta",
  "description": "AI agent Git workflow helpers for intent-based commits, release checks, and repository handoffs.",
  "lead": "Split, verify, checkpoint, and land agent-assisted changes while preserving reviewable git intent.",
  "quickstart": "pnpm add -g @async/auto-git\npnpm run pipeline:verify",
  "docsRoots": [
    "docs"
  ]
};
const outDir = ".async/pages";
const asyncProjects = [
  ["@async/db", "https://async.github.io/db/", "Data workflow"],
  ["@async/web", "https://async.github.io/web/", "Web runtime"],
  ["@async/pipeline", "https://async.github.io/pipeline/", "Pipeline workflows"],
  ["@async/dispatch", "https://async.github.io/dispatch/", "Goal-first coordination"],
  ["@async/auto-git", "https://async.github.io/auto-git/", "Git handoffs"],
  ["@async/api-contract", "https://async.github.io/api-contract/", "API ledgers"],
  ["@async/claims", "https://async.github.io/claims/", "Doc claim checks"]
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const readme = await readFile("README.md", "utf8");
const docs = await collectDocs(site.docsRoots);
for (const doc of docs) {
  const markdown = await readFile(doc.path, "utf8");
  const htmlPath = join(outDir, doc.href);
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, layout({
    title: doc.title,
    body: renderMarkdown(markdown),
    rootPrefix: "../".repeat(doc.href.split("/").length - 1)
  }));
}

await writeFile(join(outDir, "index.html"), layout({
  title: site.title,
  body: home(readme, docs),
  rootPrefix: ""
}));

function home(readme, docs) {
  const guideLinks = docs.length ? docs.map((doc) =>
    `<a class="guide-link" href="${doc.href}"><span>${escapeHtml(doc.title)}</span><small>${escapeHtml(doc.source)}</small></a>`
  ).join("\n") : "<p>No guide pages are published for this repo yet.</p>";
  const related = asyncProjects
    .filter(([name]) => name !== site.title)
    .map(([name, url, label]) => `<a class="related" href="${url}"><strong>${name}</strong><span>${label}</span></a>`)
    .join("\n");
  return `
    <section class="hero">
      <p class="eyebrow">${escapeHtml(site.stage)} / Async</p>
      <h1>${escapeHtml(site.title)}</h1>
      <p class="lead">${renderInline(site.description)}</p>
      <p class="sublead">${renderInline(site.lead)}</p>
      <div class="actions">
        <a class="primary-link" href="https://github.com/async/${site.repo}">GitHub</a>
        <a href="https://www.npmjs.com/package/${encodeURIComponent(site.title)}">npm</a>
      </div>
    </section>
    <section>
      <h2>Start</h2>
      <pre><code>${escapeHtml(site.quickstart)}</code></pre>
    </section>
    <section>
      <h2>Guides</h2>
      <div class="guide-grid">${guideLinks}</div>
    </section>
    <section>
      <h2>Related Async Projects</h2>
      <div class="related-grid">${related}</div>
    </section>
    <section>
      <h2>README</h2>
      <div class="markdown">${renderMarkdown(readme)}</div>
    </section>
  `;
}

function layout({ title, body, rootPrefix }) {
  const nav = asyncProjects.map(([name, url]) =>
    `<a href="${url}"${name === site.title ? " aria-current=\"page\"" : ""}>${name.replace("@async/", "")}</a>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(site.description)}">
  <style>
    :root{color-scheme:dark;--bg:#15202b;--soft:#192734;--raised:#1f2f3d;--border:#38444d;--border2:#2f3c47;--text:#f7f9f9;--muted:#8b98a5;--body:#cfd9de;--blue:#1d9bf0;--green:#00ba7c;--code:#0f1720;--shadow:0 24px 80px rgba(2,6,23,.32)}
    *{box-sizing:border-box}html{min-height:100%;background:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(180deg,#15202b 0%,#111923 100%);background-size:40px 40px,40px 40px,auto}body{margin:0;color:var(--body);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}.container{width:min(100% - 32px,1080px);margin:48px auto 72px}.page{overflow:hidden;background:rgba(25,39,52,.94);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}.topbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding:16px clamp(24px,4vw,56px);background:rgba(15,23,32,.72);border-bottom:1px solid var(--border)}.brand{display:inline-flex;align-items:center;gap:10px;color:var(--text);font-weight:850}.mark{display:grid;width:26px;height:26px;grid-template-columns:repeat(2,1fr);gap:4px}.mark span{border:1px solid var(--blue);border-radius:3px}.mark span:nth-child(2){border-color:var(--green)}.mark span:nth-child(3){border-color:#facc15}.mark span:nth-child(4){border-color:#7dd3fc}.nav{display:flex;flex-wrap:wrap;gap:14px;font-size:.92rem;font-weight:750}.nav a{color:var(--muted)}.nav a[aria-current=page]{color:var(--text)}main{padding:clamp(24px,4vw,56px)}.eyebrow{margin:0 0 12px;color:var(--blue);font-size:.78rem;font-weight:850;letter-spacing:.08em;text-transform:uppercase}h1,h2,h3{color:var(--text);line-height:1.2;letter-spacing:0}h1{max-width:820px;margin:0 0 16px;font-size:clamp(2.25rem,5vw,4.5rem);font-weight:850}h2{margin:48px 0 16px;padding-top:28px;border-top:1px solid var(--border);font-size:clamp(1.45rem,3vw,2rem)}h3{margin:28px 0 10px;font-size:1.14rem}.lead{max-width:820px;color:var(--text);font-size:clamp(1.18rem,2.4vw,1.45rem);line-height:1.45}.sublead{max-width:820px;color:var(--muted);font-size:1.05rem}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.actions a{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;color:var(--text);font-weight:800;background:rgba(15,23,32,.54);border:1px solid var(--border);border-radius:10px}.actions .primary-link{color:#06101f;background:var(--blue);border-color:var(--blue)}.guide-grid,.related-grid{display:grid;gap:12px;margin-top:18px}@media (min-width:760px){.guide-grid,.related-grid{grid-template-columns:repeat(2,1fr)}}.guide-link,.related{display:block;padding:16px 18px;background:rgba(15,23,32,.48);border:1px solid var(--border2);border-radius:12px}.guide-link span,.related strong{display:block;color:var(--text);font-weight:800}.guide-link small,.related span{display:block;margin-top:4px;color:var(--muted)}pre{overflow-x:auto;margin:1rem 0 1.5rem;padding:18px 20px;color:var(--body);background:linear-gradient(180deg,#101923 0%,#0d141d 100%);border:1px solid var(--border2);border-radius:12px}code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.92em}p code,li code{padding:.1rem .35rem;color:var(--text);background:rgba(15,23,32,.65);border:1px solid var(--border2);border-radius:6px}.markdown p{max-width:860px}.markdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.markdown th,.markdown td{padding:8px 10px;border:1px solid var(--border2)}.markdown blockquote{margin:18px 0;padding:2px 0 2px 18px;color:var(--muted);border-left:3px solid var(--blue)}footer{padding:20px clamp(24px,4vw,56px);color:var(--muted);border-top:1px solid var(--border)}
  </style>
</head>
<body>
  <div class="container"><div class="page"><header class="topbar"><a class="brand" href="${rootPrefix}index.html"><span class="mark"><span></span><span></span><span></span><span></span></span><span>${escapeHtml(site.title)}</span></a><nav class="nav">${nav}</nav></header><main>${body}</main><footer>Built by <code>pnpm run pipeline:pages</code>. Workflow source: <code>${escapeHtml(site.pipelineFile ?? "pipeline.ts")}</code>.</footer></div></div>
</body>
</html>
`;
}

async function collectDocs(roots) {
  const docs = [];
  for (const root of roots) {
    try { await stat(root); } catch { continue; }
    await walk(root, docs);
  }
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

async function walk(dir, docs) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".async", "dist", "_site"].includes(entry.name)) continue;
      await walk(path, docs);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const source = await readFile(path, "utf8");
    const rel = relative(process.cwd(), path).replaceAll("\\", "/");
    const href = rel.replace(/\.md$/, ".html");
    docs.push({ path, source: rel, href, title: firstHeading(source) || basename(path, ".md") });
  }
}

function renderMarkdown(source) {
  const lines = source.split(/\r?\n/);
  const html = [];
  let list = "";
  let code = null;
  let table = [];
  const closeList = () => { if (list) { html.push(`</${list}>`); list = ""; } };
  const closeTable = () => { if (table.length) { html.push(renderTable(table)); table = []; } };
  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList(); closeTable();
      if (code) { html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = null; } else { code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    if (line.startsWith("|")) { closeList(); table.push(line); continue; }
    closeTable();
    if (/^###\s+/.test(line)) { closeList(); html.push(`<h3 id="${slug(line.slice(4))}">${renderInline(line.slice(4))}</h3>`); continue; }
    if (/^##\s+/.test(line)) { closeList(); html.push(`<h2 id="${slug(line.slice(3))}">${renderInline(line.slice(3))}</h2>`); continue; }
    if (/^#\s+/.test(line)) { closeList(); html.push(`<h2 id="${slug(line.slice(2))}">${renderInline(line.slice(2))}</h2>`); continue; }
    if (/^-\s+/.test(line)) { if (list !== "ul") { closeList(); list = "ul"; html.push("<ul>"); } html.push(`<li>${renderInline(line.slice(2))}</li>`); continue; }
    if (/^\d+\.\s+/.test(line)) { if (list !== "ol") { closeList(); list = "ol"; html.push("<ol>"); } html.push(`<li>${renderInline(line.replace(/^\d+\.\s+/, ""))}</li>`); continue; }
    if (/^>\s?/.test(line)) { closeList(); html.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList(); html.push(`<p>${renderInline(line.trim())}</p>`);
  }
  closeList(); closeTable();
  return html.join("\n");
}

function renderTable(lines) {
  const rows = lines.map((line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim()));
  const body = rows.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell))).map((row, index) => {
    const tag = index === 0 ? "th" : "td";
    return `<tr>${row.map((cell) => `<${tag}>${renderInline(cell)}</${tag}>`).join("")}</tr>`;
  }).join("\n");
  return `<table>${body}</table>`;
}

function renderInline(value) {
  return String(value).split(/(`[^`]+`)/g).map((segment) => {
    if (segment.startsWith("`") && segment.endsWith("`")) {
      return `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
    }
    return renderTextLinks(segment);
  }).join("");
}

function renderTextLinks(value) {
  return String(value).split(/(\[[^\]]+\]\([^)]+\))/g).map((segment) => {
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(segment);
    if (match) return `<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`;
    let html = escapeHtml(segment);
    for (const [name, url] of asyncProjects) {
      if (name === site.title) continue;
      html = html.replace(new RegExp(escapeRegExp(name), "g"), `<a href="${url}">${name}</a>`);
    }
    return html;
  }).join("");
}

function firstHeading(source) {
  return source.split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "";
}
function slug(value) { return String(value).toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section"; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
