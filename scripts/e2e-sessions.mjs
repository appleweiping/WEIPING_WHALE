import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = mkdtempSync(join(tmpdir(), "ww-sess-state-"));
process.env.WEIPING_WHALE_HOME = stateHome;

const s = await import("../src/session.ts");

try {
  const runtime = { model: "deepseek-v4-flash", thinking: "disabled", reasoning_effort: "high" };
  const cwd = process.cwd();

  // Create a base session with a few messages.
  const baseId = s.createSessionId() + "-base";
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "first question about foo" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "answer 2" },
  ];
  s.saveSession(baseId, cwd, runtime, msgs);

  const loaded = s.loadSession(baseId);
  assert.ok(loaded, "base session should load");
  assert.equal(loaded.schema_version, s.SESSION_SCHEMA_VERSION, "schema_version set");
  assert.equal(loaded.title, "first question about foo", `title derived: got ${loaded.title}`);

  // resolveSessionRef: exact, prefix, last.
  assert.equal(s.resolveSessionRef(baseId).session?.id, baseId, "exact resolve");
  const prefix = baseId.slice(0, baseId.length - 3);
  const byPrefix = s.resolveSessionRef(prefix);
  assert.equal(byPrefix.session?.id, baseId, `prefix resolve: ${byPrefix.error ?? "ok"}`);
  const last = s.resolveSessionRef("last");
  assert.equal(last.session?.id, baseId, "last resolves to most recent");

  // Fork: child shares history + records parent linkage.
  const childId = s.forkSession(baseId, cwd, runtime, msgs);
  assert.ok(childId, "fork should produce a child id");
  const child = s.loadSession(childId);
  assert.equal(child.parent_session_id, baseId, "child records parent");
  assert.equal(child.forked_from_message_count, msgs.length, "fork point recorded");
  assert.equal(child.messages.length, msgs.length, "child shares full history");

  // Mutating the child must not affect the parent.
  s.saveSession(childId, cwd, runtime, [...child.messages, { role: "user", content: "child-only" }]);
  assert.equal(s.loadSession(baseId).messages.length, msgs.length, "parent unchanged after child grows");
  assert.equal(s.loadSession(childId).messages.length, msgs.length + 1, "child grew");

  // Backtrack: rewind 1 user-turn keeps system + first exchange (cuts at 2nd user msg).
  const back1 = s.backtrackMessages(msgs, 1);
  assert.deepEqual(
    back1.map((m) => m.content),
    ["sys", "first question about foo", "answer 1"],
    `backtrack 1 should cut at last user msg, got ${JSON.stringify(back1.map((m) => m.content))}`,
  );
  // Backtrack 2 keeps only the system prompt.
  const back2 = s.backtrackMessages(msgs, 2);
  assert.deepEqual(back2.map((m) => m.content), ["sys"], "backtrack 2 keeps only system");

  // Ambiguous prefix should error.
  s.saveSession(prefix + "xx", cwd, runtime, msgs);
  const amb = s.resolveSessionRef(prefix);
  assert.ok(amb.error && /ambiguous/i.test(amb.error), "ambiguous prefix errors");

  console.log("session e2e ok");
} finally {
  rmSync(stateHome, { recursive: true, force: true });
}
