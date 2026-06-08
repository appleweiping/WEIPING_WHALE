import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the state root at a temp dir so we don't pollute the real one.
const stateHome = mkdtempSync(join(tmpdir(), "ww-snap-state-"));
process.env.WEIPING_WHALE_HOME = stateHome;

// Run under tsx so the TypeScript source imports resolve.
const mod = await import("../src/snapshot/manager.ts");
const SM = mod.SnapshotManager;

const ws = mkdtempSync(join(tmpdir(), "ww-snap-ws-"));
try {
  // Initial file.
  const fileA = join(ws, "a.txt");
  writeFileSync(fileA, "original\n", "utf-8");

  const mgr = new SM(ws, { enabled: true });
  assert.equal(mgr.isEnabled(), true, `snapshots should be enabled: ${mgr.reason()}`);

  // Turn 1: snapshot, then model "edits" the file and creates a new one.
  mgr.beforeTurn();
  writeFileSync(fileA, "MODIFIED\n", "utf-8");
  const fileB = join(ws, "b.txt");
  writeFileSync(fileB, "new file\n", "utf-8");
  mgr.afterTurn();

  // List should contain pre-turn:1 and post-turn:1.
  const snaps = mgr.list(10);
  assert.ok(snaps.length >= 2, `expected >=2 snapshots, got ${snaps.length}`);
  assert.ok(snaps.some((s) => s.label === "pre-turn:1"), "pre-turn:1 missing");
  assert.ok(snaps.some((s) => s.label === "post-turn:1"), "post-turn:1 missing");

  // revert_turn -> should restore a.txt to "original" and DELETE b.txt.
  const rev = mgr.revertTurn();
  assert.equal(rev.ok, true, `revertTurn failed: ${rev.error}`);
  assert.equal(readFileSync(fileA, "utf-8"), "original\n", "a.txt not reverted");
  assert.equal(existsSync(fileB), false, "b.txt should have been deleted on revert");

  // Now test /undo path: make a change, undo should roll it back.
  mgr.beforeTurn();
  writeFileSync(fileA, "CHANGED AGAIN\n", "utf-8");
  mgr.afterTurn();
  const undo = mgr.undo();
  assert.equal(undo.ok, true, `undo failed: ${undo.error}`);
  // After undo we expect a.txt to not be "CHANGED AGAIN" (rolled back to a prior snapshot).
  assert.notEqual(readFileSync(fileA, "utf-8"), "CHANGED AGAIN\n", "undo did not roll back");

  // restore by explicit prefix.
  const target = mgr.list(20).find((s) => s.label === "pre-turn:1");
  assert.ok(target, "pre-turn:1 should still be listable");
  const restored = mgr.restore(target.id.slice(0, 10));
  assert.equal(restored.ok, true, `restore by prefix failed: ${restored.error}`);

  // Verify the side repo lives under the temp state root, NOT in the workspace.
  assert.equal(existsSync(join(ws, ".git")), false, "workspace .git must NOT be created");

  console.log("snapshot e2e ok");
} finally {
  rmSync(ws, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
}
