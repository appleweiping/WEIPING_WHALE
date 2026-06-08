import assert from "node:assert/strict";

const c = await import("../src/compaction.ts");

function msg(role, content, extra = {}) {
  return { role, content, ...extra };
}

// Build a transcript: system + many turns, with an error, a patch, a tool pair,
// and a working-set file mention.
const messages = [
  msg("system", "you are an agent"),
  msg("user", "please edit src/foo.ts"),                       // 1 working-set mention
  msg("assistant", "sure", { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] }), // 2 call
  msg("tool", "file contents here", { tool_call_id: "t1" }),   // 3 result (pair w/ 2)
  msg("user", "hmm"),                                          // 4
  msg("assistant", "Error: TypeError cannot read property"),   // 5 error -> pin
  msg("user", "fix it"),                                       // 6
  msg("assistant", "diff --git a/x b/x\n+++ b/x"),             // 7 patch -> pin
  msg("user", "ok"),                                           // 8
  msg("assistant", "filler 1"),                                // 9
  msg("user", "filler 2"),                                     // 10
  msg("assistant", "filler 3"),                                // 11
  msg("user", "recent A"),                                     // 12 recent tail
  msg("assistant", "recent B"),                                // 13 recent tail
  msg("user", "recent C"),                                     // 14 recent tail
  msg("assistant", "recent D"),                                // 15 recent tail
];

const plan = c.planCompaction(messages);
const pinned = new Set(plan.pinned);

// System pinned.
assert.ok(pinned.has(0), "system pinned");
// Recent tail (last 4) pinned: 12,13,14,15.
for (const i of [12, 13, 14, 15]) assert.ok(pinned.has(i), `recent ${i} pinned`);
// Error message pinned.
assert.ok(pinned.has(5), "error msg pinned");
// Patch message pinned.
assert.ok(pinned.has(7), "patch msg pinned");
// Working-set: msg 1 mentions src/foo.ts but is OUTSIDE the recent-scan window,
// so it should NOT be pinned via working set (only recent mentions count).
assert.ok(!pinned.has(1), "old working-set mention not auto-pinned");

// But a RECENT working-set mention IS pinned. Build a short transcript where the
// path appears within the scan window.
const wsMsgs = [
  msg("system", "s"),
  msg("user", "touch src/widget.ts"),  // 1 within last-12 of a short list
  msg("assistant", "done"),            // 2
  msg("user", "and check src/widget.ts behavior"), // 3 recent mention
  msg("assistant", "ok"), msg("user", "x"), msg("assistant", "y"), msg("user", "z"),
];
const wsPlan = c.planCompaction(wsMsgs);
const wsPinned = new Set(wsPlan.pinned);
assert.ok(wsPinned.has(1) || wsPinned.has(3), "recent working-set mention pinned");

// Tool-pair integrity: if result (3) pinned, call (2) must be pinned, and vice versa.
// Neither is forced-pinned by heuristics here, but if one is pinned both must be.
assert.equal(pinned.has(2), pinned.has(3), "tool call/result pinned together");

// summarize + pinned partition all indices, no overlap.
const all = new Set([...plan.pinned, ...plan.summarize]);
assert.equal(all.size, messages.length, "partition covers all");
assert.equal(plan.pinned.length + plan.summarize.length, messages.length, "no overlap");

// shouldCompact true when enough to summarize.
assert.equal(c.shouldCompact(plan), plan.summarize.length >= 6, "threshold logic");

// deriveWorkingSet picks up the path from recent scan window.
const ws = c.deriveWorkingSet(messages);
// foo.ts is at index 1, outside the last-12 window for a 16-msg list, so may not appear;
// add a recent mention and re-check.
const ws2 = c.deriveWorkingSet([...messages, msg("user", "look at src/bar.ts again")]);
assert.ok(ws2.includes("src/bar.ts"), `working set should include src/bar.ts: ${JSON.stringify(ws2)}`);

// buildSummaryInput truncates tool results and labels roles.
const input = c.buildSummaryInput(messages, [2, 3, 5], false);
assert.match(input, /\[assistant calls=read_file\]/, "labels tool calls");
assert.match(input, /\[tool result\]/, "labels tool results");

// Force a tool result to be pinned and verify its call gets pinned too.
const m2 = [
  msg("system", "s"),
  msg("assistant", "x", { tool_calls: [{ id: "z", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"Error:\"}" } }] }), // 1 (args contain Error: -> pinned)
  msg("tool", "match", { tool_call_id: "z" }), // 2
  msg("user", "next"),
  msg("assistant", "a"), msg("user", "b"), msg("assistant", "c"), msg("user", "d"),
];
const p2 = c.planCompaction(m2);
const s2 = new Set(p2.pinned);
assert.equal(s2.has(1), s2.has(2), "forced tool pair stays together");

console.log("compaction e2e ok");
