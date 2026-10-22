// End-to-end test of the whole agent loop: the built CLI talks to the scripted
// mock model, runs a real shell command, reads a file, previews a patch, applies
// it, re-runs the test and lists the side-git snapshots.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDemo, stripAnsi } from "./demo.mjs";

const demo = await runDemo({ keep: true });
try {
  const out = stripAnsi(demo.transcript);

  // Turn 1: the failing test is observed through a real shell call.
  assert.match(out, /execute_bash failed/);
  assert.match(out, /returns "hello-world-"/, "the mock quotes the real assertion output");

  // The edit is a preview until /apply.
  const patchId = out.match(/\/apply ([0-9a-f]{8})/)?.[1];
  assert.ok(patchId, "a patch preview id was printed");
  assert.match(out, new RegExp(`Applied patch ${patchId}`));
  const source = readFileSync(join(demo.workspace, "src", "slugify.mjs"), "utf8");
  assert.match(source, /replace\(\/\^-\+\|-\+\$\/g, ""\)/, "the patch reached the file");

  // Turn 2: the same test now passes.
  assert.match(out, /Ran `node test\.mjs`: 2 tests passed/);

  // Two turns -> four side-git snapshots, and the user's workspace has no .git.
  assert.equal((out.match(/(pre|post)-turn:\d/g) ?? []).length, 4);
  assert.equal(existsSync(join(demo.workspace, ".git")), false);

  // The session was written, and the cost footer was rendered from usage data.
  assert.ok(existsSync(join(demo.home, "sessions", "demo.json")));
  assert.match(out, /\$\d+\.\d{4} · [\d.]+k tok · cache \d+%/);

  // Every request carried the tool list and the system prompt.
  assert.ok(demo.requests.length >= 6);
  for (const request of demo.requests) {
    assert.equal(request.messages[0].role, "system");
    assert.ok(request.tools.some((tool) => tool.function.name === "edit_file"));
  }
} finally {
  demo.cleanup();
}

console.log("agent loop e2e ok");
