import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const releaseRoots = [
  "README.md",
  "config.toml",
  "package.json",
  "package-lock.json",
  "src",
  "scripts",
  "dist",
  ".github",
  ".codex",
].filter((item) => existsSync(join(root, item)));

const blocked = [
  { code: "retired-agent-hub", pattern: new RegExp(["agent", "hub"].join("-"), "i") },
  { code: "retired-mailbox", pattern: new RegExp(`${["messages", "deepseek"].join("-")}\\.json`, "i") },
  { code: "legacy-markdown-memory", pattern: /D:[\\/](research|Research)[\\/].*memory/i },
  { code: "legacy-session-dump", pattern: /memory[\\/]sessions/i },
  { code: "raw-secret-looking-key", pattern: /sk-[A-Za-z0-9_-]{12,}/ },
  { code: "stale-20kb-claim", pattern: new RegExp(`\\b${"20"}${"KB"}\\b`, "i") },
  { code: "stale-three-deps-claim", pattern: new RegExp(["three", "runtime", "dependencies"].join(" "), "i") },
  { code: "mirror-registry-lock", pattern: /registry\.npmmirror\.com/i },
];

const failures = [];
for (const file of listFiles(releaseRoots)) {
  const text = readFileSync(file, "utf-8");
  for (const rule of blocked) {
    if (rule.pattern.test(text)) {
      failures.push(`${rule.code}: ${relative(root, file)}`);
    }
  }
}

const packFiles = npmPackDryRunFiles();
const packFileSet = new Set(packFiles);
for (const expected of ["LICENSE", "README.md", "CHANGELOG.md", "config.toml", "package.json", "dist/index.js"]) {
  if (!packFileSet.has(expected)) failures.push(`pack-missing-required-file: ${expected}`);
}
for (const unexpected of packFiles) {
  if (/^(src|scripts|\.codex|\.github|node_modules|assets)\//.test(unexpected)) {
    failures.push(`pack-unexpected-source-file: ${unexpected}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
  const normalizedTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!packFileSet.has(normalizedTarget)) failures.push(`pack-bin-target-missing: ${name} -> ${target}`);
}
if (packageJson.version !== "0.2.0") failures.push(`package-version-mismatch: ${packageJson.version}`);

const packagedConfig = readFileSync(join(root, "config.toml"), "utf-8");
for (const pattern of [/D:[\\/]/i, /agent-resources/i, /ARIS/i, /Vipin/i, /agent hub/i]) {
  if (pattern.test(packagedConfig)) failures.push(`packaged-config-private-reference: ${pattern}`);
}

validateReadmeLinks(packFileSet, failures);

assert.deepEqual(failures, [], `Release scan failed:\n${failures.join("\n")}`);

const distPath = join(root, "dist", "index.js");
if (existsSync(distPath)) {
  const bytes = statSync(distPath).size;
  assert.ok(bytes > 10_000, "dist/index.js looks unexpectedly small");
  assert.ok(bytes < 250_000, `dist/index.js is ${bytes} bytes; revisit README size claims and package surface`);
  console.log(JSON.stringify({ ok: true, dist_bytes: bytes }));
} else {
  console.log(JSON.stringify({ ok: true, dist_missing: true }));
}

function listFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isFile()) {
      files.push(full);
      continue;
    }
    walk(full, files);
  }
  return files.filter((file) => {
    if (/[\\\/](node_modules|assets|\.git)[\\\/]/.test(file)) return false;
    return relative(root, file) !== join("scripts", "release-scan.mjs");
  });
}

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (["node_modules", "assets", ".git"].includes(name)) continue;
      walk(full, files);
    } else if (stat.isFile()) {
      files.push(full);
    }
  }
}

function npmPackDryRunFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const jsonStart = result.stdout.indexOf("[");
  const entries = JSON.parse(result.stdout.slice(jsonStart));
  return entries[0].files.map((file) => file.path.replace(/\\/g, "/"));
}

function validateReadmeLinks(packFileSet, failures) {
  const readme = readFileSync(join(root, "README.md"), "utf-8");
  const refs = [
    ...Array.from(readme.matchAll(/<img\s+[^>]*src="([^"]+)"/gi), (match) => match[1]),
    ...Array.from(readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1]),
    ...Array.from(readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), (match) => match[1]),
  ];
  for (const ref of refs) {
    const target = ref.split("#")[0].trim();
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    if (!existsSync(join(root, target))) failures.push(`readme-link-missing-file: ${ref}`);
    if (!packFileSet.has(target.replace(/\\/g, "/"))) failures.push(`readme-link-not-in-package: ${ref}`);
  }
}
