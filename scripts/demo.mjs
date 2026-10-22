// Drives a real WEIPING_WHALE session against the scripted mock model.
//
//   npm run build && npm run demo           # print the session
//   node scripts/demo.mjs --svg docs/demo.svg
//
// The CLI, its tools, the patch preview, side-git snapshots and the session
// file are all real; only the model is replaced by scripts/mock-deepseek.mjs.
// The demo works in a throwaway copy of a tiny project whose test fails.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockDeepSeek } from "./mock-deepseek.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT = "━━ ";

export const DEMO_FILES = {
  "src/slugify.mjs": [
    "export function slugify(title) {",
    "  return title",
    "    .toLowerCase()",
    '    .replace(/[^a-z0-9]+/g, "-");',
    "}",
    "",
  ].join("\n"),
  "test.mjs": [
    'import assert from "node:assert/strict";',
    'import { slugify } from "./src/slugify.mjs";',
    "",
    'assert.equal(slugify("Hello, World!"), "hello-world");',
    'assert.equal(slugify("  Already--slugged  "), "already-slugged");',
    'console.log("2 tests passed");',
    "",
  ].join("\n"),
};

/**
 * Run the scripted session. Returns the raw transcript (with ANSI colours),
 * the workspace path (still on disk until cleanup() is called) and the
 * requests the mock model received.
 */
export async function runDemo({ keep = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "whale-demo-"));
  const workspace = join(base, "slugify-demo");
  const home = join(base, "state");
  for (const [path, content] of Object.entries(DEMO_FILES)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content, "utf8");
  }
  const configPath = join(base, "config.toml");
  writeFileSync(
    configPath,
    [
      "[llm]",
      'model = "flash"',
      'thinking = "disabled"',
      "",
      "[lsp]",
      "enabled = false",
      "",
    ].join("\n"),
    "utf8",
  );

  const mock = await startMockDeepSeek();
  const child = spawn(process.execPath, [join(root, "dist", "index.js"), "--cwd", workspace, "--session", "demo"], {
    cwd: workspace,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "mock-key",
      DEEPSEEK_BASE_URL: mock.url,
      WEIPING_WHALE_CONFIG: configPath,
      WEIPING_WHALE_HOME: home,
      DEEPSEEK_APPROVAL_MODE: "on-request",
      DEEPSEEK_WRITE_MODE: "preview",
      DEEPSEEK_SANDBOX_MODE: "workspace-write",
      DEEPSEEK_DISABLE_AGENTMEMORY: "1",
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let transcript = "";
  let stdout = "";
  const waiters = [];
  const onData = (chunk, isStdout) => {
    const value = chunk.toString("utf8");
    transcript += value;
    if (isStdout) stdout += value;
    for (const waiter of [...waiters]) waiter();
  };
  child.stdout.on("data", (chunk) => onData(chunk, true));
  child.stderr.on("data", (chunk) => onData(chunk, false));
  const exited = new Promise((done) => child.on("close", (code) => done(code)));

  const promptCount = () => stdout.split(PROMPT).length - 1;
  const waitForPrompt = (count) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`demo timed out waiting for prompt #${count}\n${transcript}`)), 60_000);
      const check = () => {
        if (promptCount() >= count) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          done();
        }
      };
      waiters.push(check);
      check();
    });
  let prompts = 1;
  const say = async (line) => {
    await waitForPrompt(prompts);
    // Status lines (footer, "thinking...") go to stderr, the prompt to stdout.
    // Give stderr a moment so the transcript keeps the order a terminal shows.
    await new Promise((done) => setTimeout(done, 250));
    transcript += `${line}\n`; // what the user would see echoed by their terminal
    child.stdin.write(`${line}\n`);
    prompts += 1;
  };

  try {
    await say("test.mjs fails, find the bug and fix it");
    await waitForPrompt(prompts);
    const patchId = transcript.match(/\/apply ([0-9a-f]{8})/)?.[1];
    if (!patchId) throw new Error(`mock reply did not include a patch id\n${transcript}`);
    await say(`/apply ${patchId}`);
    await say("run the tests again");
    await say("/snapshots");
    await say("/exit");
    const code = await exited;
    if (code !== 0) throw new Error(`wwhale exited with ${code}\n${transcript}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await mock.close();
  }

  const cleanup = () => rmSync(base, { recursive: true, force: true });
  if (!keep) cleanup();
  return { transcript, workspace, home, requests: mock.requests, cleanup };
}

export function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Replace machine-specific temp paths so the transcript can be published. */
export function tidyPaths(value, { workspace, home }) {
  let out = value;
  // WEIPING_WHALE_HOME points straight at the state directory, so `home` is
  // what a normal install keeps in ~/.weiping-whale.
  for (const [path, label] of [[workspace, "~/slugify-demo"], [home, "~/.weiping-whale"]]) {
    for (const variant of [path, path.replace(/\\/g, "/")]) out = out.split(variant).join(label);
  }
  // Windows separators after the substituted prefix, so the transcript reads the
  // same on every platform.
  out = out.replace(/~(?:\/[\w.-]+)*(?:\\[\w.-]+)+/g, (match) => match.replace(/\\/g, "/"));
  return out.replace(/\r/g, "");
}

// Minimal ANSI -> SVG renderer for the README screenshot. Handles the handful
// of SGR codes the CLI uses (bold, dim, 8 colours, reset).
export function renderSvg(ansiText, { title = "wwhale" } = {}) {
  const palette = { 31: "#f7768e", 32: "#9ece6a", 33: "#e0af68", 34: "#7aa2f7", 36: "#7dcfff" };
  const lines = ansiText.replace(/\n+$/, "").split("\n");
  const charW = 8.4;
  const lineH = 18;
  const pad = 16;
  const top = 40;
  const cols = Math.max(60, ...lines.map((line) => [...stripAnsi(line)].length));
  const width = Math.ceil(pad * 2 + cols * charW);
  const height = top + pad + lines.length * lineH;
  const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = lines.map((line, index) => {
    let style = { color: null, bold: false, dim: false };
    const spans = [];
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
      if (sgr) {
        for (const code of (sgr[1] || "0").split(";").map(Number)) {
          if (code === 0) style = { color: null, bold: false, dim: false };
          else if (code === 1) style = { ...style, bold: true };
          else if (code === 2) style = { ...style, dim: true };
          else if (palette[code]) style = { ...style, color: palette[code] };
        }
        continue;
      }
      if (!part) continue;
      const attrs = [];
      if (style.color) attrs.push(`fill="${style.color}"`);
      if (style.bold) attrs.push('font-weight="bold"');
      if (style.dim) attrs.push('opacity="0.6"');
      spans.push(attrs.length ? `<tspan ${attrs.join(" ")}>${escapeXml(part)}</tspan>` : escapeXml(part));
    }
    return `<text x="${pad}" y="${top + pad + index * lineH}" xml:space="preserve">${spans.join("")}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" rx="8" fill="#1a1b26"/>`,
    `<circle cx="20" cy="18" r="6" fill="#f7768e"/><circle cx="40" cy="18" r="6" fill="#e0af68"/><circle cx="60" cy="18" r="6" fill="#9ece6a"/>`,
    `<text x="${width / 2}" y="22" text-anchor="middle" fill="#a9b1d6" opacity="0.7" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">${escapeXml(title)}</text>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" fill="#c0caf5">`,
    ...rows,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const svgPath = args.includes("--svg") ? args[args.indexOf("--svg") + 1] : undefined;
  const demo = await runDemo({ keep: true });
  try {
    const tidy = tidyPaths(demo.transcript, demo);
    process.stdout.write(tidy);
    if (svgPath) {
      writeFileSync(svgPath, renderSvg(tidy, { title: "wwhale --cwd ~/slugify-demo   (scripted mock model)" }), "utf8");
      process.stderr.write(`\nwrote ${svgPath}\n`);
    }
  } finally {
    demo.cleanup();
  }
}
