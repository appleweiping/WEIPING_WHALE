import assert from "node:assert/strict";

const { startRuntimeApi } = await import("../src/server/runtime-api.ts");

// Stub deps: a fake agent + cost tracker + a runTurn that echoes.
const deps = {
  agent: {},
  costTracker: { snapshot: () => ({ costUsd: 0.5, turns: 2, promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 }) },
  runTurn: async (m) => `echo: ${m}`,
};

const api = await startRuntimeApi(deps, { host: "127.0.0.1", port: 0 }); // port 0 = ephemeral
const base = api.url.replace(/:0$/, ""); // url uses 0; get actual port from server address
const addr = api.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const root = `http://127.0.0.1:${port}`;

try {
  // 1. /health is unauthenticated.
  const health = await fetch(`${root}/health`);
  assert.equal(health.status, 200, "health 200");
  const hbody = await health.json();
  assert.equal(hbody.ok, true, "health ok");
  assert.equal(hbody.service, "weiping-whale", "service name");

  // 2. /v1 without token -> 401.
  const noAuth = await fetch(`${root}/v1/cost`);
  assert.equal(noAuth.status, 401, "no token -> 401");

  // 3. /v1 with WRONG token -> 401.
  const badAuth = await fetch(`${root}/v1/cost`, { headers: { Authorization: "Bearer wrong-token" } });
  assert.equal(badAuth.status, 401, "wrong token -> 401");

  // 4. /v1/cost with correct token.
  const auth = { Authorization: `Bearer ${api.token}` };
  const cost = await fetch(`${root}/v1/cost`, { headers: auth });
  assert.equal(cost.status, 200, "cost 200 with token");
  assert.equal((await cost.json()).turns, 2, "cost body");

  // 5. /v1/message runs a turn.
  const msg = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(msg.status, 200, "message 200");
  assert.equal((await msg.json()).reply, "echo: hello", "turn ran");

  // 6. /v1/message with empty body -> 400.
  const empty = await fetch(`${root}/v1/message`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400, "empty message -> 400");

  // 7. SSE stream emits start/reply/done.
  const sse = await fetch(`${root}/v1/stream?message=hi`, { headers: auth });
  assert.equal(sse.status, 200, "stream 200");
  assert.match(sse.headers.get("content-type") || "", /text\/event-stream/, "sse content-type");
  const text = await sse.text();
  assert.match(text, /event: start/, "sse start event");
  assert.match(text, /event: reply/, "sse reply event");
  assert.match(text, /echo: hi/, "sse reply payload");
  assert.match(text, /event: done/, "sse done event");

  // 8. unknown path -> 404.
  const nf = await fetch(`${root}/nope`);
  assert.equal(nf.status, 404, "unknown path 404");

  console.log("server e2e ok");
} finally {
  await api.close();
}
