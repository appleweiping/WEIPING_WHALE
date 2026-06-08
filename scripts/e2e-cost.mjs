import assert from "node:assert/strict";

const { CostTracker } = await import("../src/cost.ts");

// Pro pricing defaults: cache_hit 0.07, cache_miss 0.56, output 1.68 per 1M.
const t = new CostTracker();

// Turn 1: 1,000,000 prompt tokens all cache-miss, 1,000,000 output tokens.
t.record("deepseek-v4-pro", {
  prompt_tokens: 1_000_000,
  completion_tokens: 1_000_000,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 1_000_000,
});
let s = t.snapshot();
// cost = 0*0.07 + 1*0.56 + 1*1.68 = 2.24
assert.ok(Math.abs(s.costUsd - 2.24) < 1e-9, `expected 2.24, got ${s.costUsd}`);
assert.equal(t.cacheHitRatio(), 0, "all miss -> 0 ratio");
assert.equal(t.cacheColor(), "red", "0% -> red");

// Turn 2: 1,000,000 prompt all cache-hit, no output.
t.record("deepseek-v4-pro", {
  prompt_tokens: 1_000_000,
  completion_tokens: 0,
  prompt_cache_hit_tokens: 1_000_000,
  prompt_cache_miss_tokens: 0,
});
s = t.snapshot();
// add 1*0.07 = 0.07 -> total 2.31
assert.ok(Math.abs(s.costUsd - 2.31) < 1e-9, `expected 2.31, got ${s.costUsd}`);
// ratio now 1,000,000 hit / 2,000,000 total = 0.5
assert.equal(t.cacheHitRatio(), 0.5, "ratio 0.5");
assert.equal(t.cacheColor(), "yellow", "50% -> yellow");

// Provider reports no cache fields -> treat all as miss.
const t2 = new CostTracker();
t2.record("deepseek-v4-flash", { prompt_tokens: 1_000_000, completion_tokens: 0 });
const s2 = t2.snapshot();
assert.equal(s2.cacheMissTokens, 1_000_000, "no-cache-fields -> all miss");
assert.equal(s2.cacheHitTokens, 0);

// Only HIT reported -> derive miss = prompt - hit.
const tHit = new CostTracker();
tHit.record("deepseek-v4-flash", { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 700 });
assert.equal(tHit.snapshot().cacheMissTokens, 300, "derive miss from prompt-hit");

// Only MISS reported -> derive hit = prompt - miss (must NOT drop hits to zero).
const tMiss = new CostTracker();
tMiss.record("deepseek-v4-flash", { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_miss_tokens: 200 });
assert.equal(tMiss.snapshot().cacheHitTokens, 800, "derive hit from prompt-miss");

// Negative / NaN usage is clamped.
const tBad = new CostTracker();
tBad.record("deepseek-v4-flash", { prompt_tokens: -5, completion_tokens: NaN, prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: -2 });
const sBad = tBad.snapshot();
assert.equal(sBad.promptTokens, 0, "negative prompt clamped");
assert.equal(sBad.completionTokens, 0, "NaN completion clamped");
assert.equal(sBad.costUsd, 0, "no cost from clamped-zero usage");

// Footer format sanity.
assert.match(t.footer(), /\$\d+\.\d{4} · .* tok · cache \d+%/, `footer format: ${t.footer()}`);

// High cache ratio -> green.
const t3 = new CostTracker();
t3.record("deepseek-v4-pro", { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_cache_hit_tokens: 900_000, prompt_cache_miss_tokens: 100_000 });
assert.equal(t3.cacheColor(), "green", "90% -> green");

// Custom pricing override.
const t4 = new CostTracker({ "deepseek-v4-pro": { output_usd: 10 } });
t4.record("deepseek-v4-pro", { prompt_tokens: 0, completion_tokens: 1_000_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });
assert.ok(Math.abs(t4.snapshot().costUsd - 10) < 1e-9, `override pricing: ${t4.snapshot().costUsd}`);

console.log("cost e2e ok");
