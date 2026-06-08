import assert from "node:assert/strict";

const { route } = await import("../src/router.ts");

// Sub-agent always low.
assert.equal(route({ lastUserMessage: "anything", isSubagent: true }).effort, "low", "subagent -> low");

// High-effort keywords -> max + pro + thinking.
for (const m of ["please debug this crash", "explain the architecture", "调试这个错误", "なぜこのバグが起きる"]) {
  const d = route({ lastUserMessage: m });
  assert.equal(d.effort, "max", `"${m}" -> max (got ${d.effort})`);
  assert.equal(d.model, "deepseek-v4-pro", `"${m}" -> pro`);
  assert.equal(d.thinking, "enabled", `"${m}" -> thinking enabled`);
  assert.equal(d.reasoning_effort, "max", `"${m}" -> effort max`);
}

// Low-effort keywords -> low + flash + no thinking.
for (const m of ["search for the config", "rename this variable", "格式化这段代码", "翻訳して"]) {
  const d = route({ lastUserMessage: m });
  assert.equal(d.effort, "low", `"${m}" -> low (got ${d.effort})`);
  assert.equal(d.model, "deepseek-v4-flash", `"${m}" -> flash`);
  assert.equal(d.thinking, "disabled", `"${m}" -> thinking disabled`);
}

// Default (no signal) -> high + flash + thinking.
const def = route({ lastUserMessage: "add a button to the page" });
assert.equal(def.effort, "high", `default -> high (got ${def.effort})`);
assert.equal(def.model, "deepseek-v4-flash", "default -> flash");
assert.equal(def.thinking, "enabled", "default -> thinking enabled");

// High beats low when both present.
const both = route({ lastUserMessage: "search the code to debug this error" });
assert.equal(both.effort, "max", "high keyword wins over low");

// Empty -> high default.
assert.equal(route({ lastUserMessage: "" }).effort, "high", "empty -> high");
assert.equal(route({ lastUserMessage: "   " }).effort, "high", "blank -> high");

// Every decision carries a reason string.
assert.ok(route({ lastUserMessage: "debug" }).reason.length > 0, "decision has reason");

console.log("router e2e ok");
