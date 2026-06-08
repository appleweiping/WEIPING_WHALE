import assert from "node:assert/strict";

const sa = await import("../src/tools/subagent.ts");
const { SubAgentManager, DONE_SENTINEL } = sa;

// Fake agent: resolves after a tick with a canned reply, records setAutoRoute.
function makeFakeAgent(reply, delayMs = 20, shouldThrow = false) {
  return {
    setAutoRoute() {},
    async run(_prompt, events) {
      await new Promise((r) => setTimeout(r, delayMs));
      events?.onToolEnd?.("noop", 1, false);
      if (shouldThrow) throw new Error("boom");
      return reply;
    },
  };
}

// 1. open + eval lifecycle, completion sentinel present.
{
  const mgr = new SubAgentManager({
    config: {}, mcpManager: {},
    makeAgent: () => makeFakeAgent("did the thing"),
    maxAgents: 4, maxDepth: 2, depth: 0,
  });
  const { id } = mgr.open("do a thing");
  assert.ok(id, "open returns id");
  const out = await mgr.waitFor(id, 2000);
  assert.match(out, /did the thing/, "result surfaced");
  assert.match(out, new RegExp(DONE_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "completion sentinel present");
  assert.equal(mgr.evalAgent(id).record.status, "completed", "status completed");
}

// 2. pool cap enforced.
{
  const mgr = new SubAgentManager({
    config: {}, mcpManager: {},
    makeAgent: () => makeFakeAgent("slow", 500),
    maxAgents: 2, maxDepth: 5, depth: 0,
  });
  assert.ok(mgr.open("a").id, "1st ok");
  assert.ok(mgr.open("b").id, "2nd ok");
  const third = mgr.open("c");
  assert.ok(third.error && /full/.test(third.error), "pool cap blocks 3rd");
}

// 3. failure path records error + sentinel.
{
  const mgr = new SubAgentManager({
    config: {}, mcpManager: {},
    makeAgent: () => makeFakeAgent("x", 10, true),
    maxAgents: 4, maxDepth: 2, depth: 0,
  });
  const { id } = mgr.open("will fail");
  const out = await mgr.waitFor(id, 2000);
  assert.match(out, /FAILED/, "failure reported");
  assert.equal(mgr.evalAgent(id).record.status, "failed", "status failed");
}

// 4. unknown id.
{
  const mgr = new SubAgentManager({ config: {}, mcpManager: {}, makeAgent: () => makeFakeAgent("x"), maxAgents: 4, maxDepth: 2, depth: 0 });
  assert.match(await mgr.waitFor("nope", 100), /no sub-agent/, "unknown id handled");
}

// 5. depth cap: while a child is live (liveDepth=1), maxDepth=1 blocks nested open.
{
  let openedNested = null;
  const mgr = new SubAgentManager({
    config: {}, mcpManager: {},
    maxAgents: 5, maxDepth: 1, depth: 0,
    makeAgent: () => ({
      setAutoRoute() {},
      async run() {
        // Try to open a nested sub-agent from within the child run.
        openedNested = mgr.open("nested");
        await new Promise((r) => setTimeout(r, 10));
        return "parent done";
      },
    }),
  });
  const { id } = mgr.open("parent");
  await mgr.waitFor(id, 2000);
  assert.ok(openedNested && openedNested.error && /depth/.test(openedNested.error), `nested open blocked by depth cap: ${JSON.stringify(openedNested)}`);
}

console.log("subagent e2e ok");
