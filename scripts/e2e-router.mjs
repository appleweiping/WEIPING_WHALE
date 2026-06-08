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

// Word-boundary matching: substrings of larger words must NOT trigger.
assert.equal(route({ lastUserMessage: "research the topic thoroughly" }).effort, "high",
  "'research' must not match the LOW keyword 'search'");
assert.equal(route({ lastUserMessage: "tell me about terror in literature" }).effort, "high",
  "'terror' must not match the HIGH keyword 'error'");
assert.equal(route({ lastUserMessage: "give me information about X" }).effort, "high",
  "'information' must not match LOW 'format'");
// But standalone words still match.
assert.equal(route({ lastUserMessage: "please search the codebase" }).effort, "low", "standalone 'search' -> low");
assert.equal(route({ lastUserMessage: "I hit an error here" }).effort, "max", "standalone 'error' -> max");

console.log("router e2e ok");
