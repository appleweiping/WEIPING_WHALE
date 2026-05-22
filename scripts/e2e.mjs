import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const node = process.execPath;
const cli = join(process.cwd(), "dist", "index.js");
const homeDir = mkdtempSync(join(tmpdir(), "deepseek-cli-home-"));
const configDir = mkdtempSync(join(tmpdir(), "deepseek-cli-config-"));
const configPath = join(configDir, "config.toml");
writeFileSync(configPath, "[llm]\nmodel = \"deepseek-v4-flash\"\napi_key_env = \"DEEPSEEK_API_KEY\"\nbase_url = \"https://api.deepseek.com\"\n\n[agent]\nworkspace = \".\"\nmax_iterations = 3\n");

function run(args, options = {}) {
  return spawnSync(node, [cli, ...args], {
    cwd: process.cwd(),
    input: options.input,
    encoding: "utf8",
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CONFIG: configPath,
      DEEPSEEK_APPROVAL_MODE: "on-request",
      DEEPSEEK_WRITE_MODE: "preview",
      DEEPSEEK_SANDBOX_MODE: "workspace-write",
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...options.env,
    },
  });
}

function json(args, options) {
  const result = run(["--json", ...args], options);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return JSON.parse(result.stdout);
}

try {
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.error?.message || version.stderr || version.stdout);
  assert.match(version.stdout, /0\.1\.0/);

  const doctor = json(["--doctor"]);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.auth.api_key, "configured");
  assert.equal(doctor.safety.write_mode, "preview");
  assert.equal(doctor.safety.approval_mode, "on-request");
  assert.equal(doctor.safety.sandbox_mode, "workspace-write");
  assert.deepEqual(doctor.mcp_diagnostics, []);

  const models = json(["--models"]);
  assert.ok(models.models.some((model) => model.name === "pro"));
  assert.equal(models.aliases.chat, "deepseek-v4-flash + thinking disabled");

  const badFlag = run(["--json", "--model="]);
  assert.equal(badFlag.status, 1, badFlag.error?.message || badFlag.stderr || badFlag.stdout);
  assert.equal(JSON.parse(badFlag.stderr).ok, false);

  const workspaceDir = mkdtempSync(join(tmpdir(), "deepseek-cli-workspace-"));
  try {
    writeFileSync(join(workspaceDir, "deepseek-cli.toml"), "[agent]\nworkspace = \".\"\n");
    const cwdDoctor = json(["--cwd", workspaceDir, "--doctor"]);
    assert.equal(cwdDoctor.cwd, workspaceDir);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  const interactive = run(["--session", "e2e-session"], { input: "/session\n/patches\n/approvals\n/exit\n" });
  assert.equal(interactive.status, 0, interactive.stderr || interactive.stdout || interactive.error?.message);
  assert.match(interactive.stdout, /session: e2e-session/);
  assert.match(interactive.stdout, /No pending file patches/);
  assert.match(interactive.stdout, /No pending shell approvals/);

  const resumed = run(["--resume", "e2e-session"], { input: "/session\n/exit\n" });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout || resumed.error?.message);
  assert.match(resumed.stdout, /session: e2e-session/);
} finally {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
}

console.log("e2e ok");
