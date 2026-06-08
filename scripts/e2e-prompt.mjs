import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const a = await import("../src/prompts/assemble.ts");

// Constitution loads and contains the authority hierarchy.
const c = a.loadConstitution();
assert.ok(c.length > 1000, "constitution should be substantial");
assert.match(c, /CONSTITUTION OF WEIPING_WHALE/, "has title");
assert.match(c, /Hierarchy of Law/, "has hierarchy article");

// Zone ordering: static -> volatile. Handoff must come after instructions and memory.
const prompt = a.assembleSystemPrompt({
  runtimeGuidance: "RUNTIME_GUIDANCE_MARKER",
  projectInstructions: [{ source: "AGENTS.md", content: "PROJECT_RULE_MARKER" }],
  memory: "MEMORY_MARKER",
  handoff: "HANDOFF_MARKER",
});
const iGuide = prompt.indexOf("RUNTIME_GUIDANCE_MARKER");
const iInst = prompt.indexOf("PROJECT_RULE_MARKER");
const iMem = prompt.indexOf("MEMORY_MARKER");
const iHand = prompt.indexOf("HANDOFF_MARKER");
assert.ok(iGuide < iInst, "guidance before instructions");
assert.ok(iInst < iMem, "instructions before memory");
assert.ok(iMem < iHand, "memory before handoff (handoff most-volatile, last)");
assert.match(prompt, /<instructions source="AGENTS.md">/, "instructions wrapped");

// Handoff round-trip + project instruction discovery in a temp workspace.
const ws = mkdtempSync(join(tmpdir(), "ww-prompt-ws-"));
try {
  writeFileSync(join(ws, "AGENTS.md"), "follow the house style", "utf-8");
  const discovered = a.discoverProjectInstructions(ws);
  assert.ok(discovered.some((d) => d.source === "AGENTS.md"), "discovers AGENTS.md");

  assert.equal(a.readHandoff(ws), undefined, "no handoff initially");
  const p = a.writeHandoff(ws, "## Open Issues\n- thing");
  assert.ok(existsSync(p), "handoff file written");
  assert.match(a.readHandoff(ws), /Open Issues/, "handoff read back");
  // handoff lives under .weiping-whale, not the repo root.
  assert.match(p.replace(/\\/g, "/"), /\.weiping-whale\/handoff\.md$/, "handoff path under state dir");
} finally {
  rmSync(ws, { recursive: true, force: true });
}

console.log("prompt e2e ok");
