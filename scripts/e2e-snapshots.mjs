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

  // Safety: a file outside the workspace, reachable only via a symlinked parent,
  // must NEVER be deleted by restore's cleanup. Build:
  //   <outside>/secret.txt   (must survive)
  //   <ws>/linkdir -> <outside>
  // Snapshot with linkdir/secret.txt "tracked", then restore to an earlier snap.
  const outside = mkdtempSync(join(tmpdir(), "ww-snap-outside-"));
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "DO NOT DELETE\n", "utf-8");
  try {
    // Take a clean baseline snapshot first.
    mgr.beforeTurn();
    writeFileSync(fileA, "baseline\n", "utf-8");
    const baseSha = mgr.afterTurn();

    // Now introduce a symlinked dir pointing outside and snapshot it.
    let symlinkSupported = true;
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(ws, "linkdir"), "junction");
    } catch {
      symlinkSupported = false;
    }
    if (symlinkSupported && baseSha) {
      mgr.beforeTurn();
      mgr.afterTurn();
      // Restore back to baseline (which did not contain linkdir/*): cleanup runs.
      mgr.restore(baseSha);
      // The external secret must still exist.
      assert.equal(existsSync(secret), true, "restore must NOT delete files outside the workspace via symlink");
      assert.equal(readFileSync(secret, "utf-8"), "DO NOT DELETE\n", "external file content preserved");
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  // Prune behavior + timestamp integrity. Use SnapshotRepo directly.
  const repoMod = await import("../src/snapshot/repo.ts");
  const repo = new repoMod.SnapshotRepo(ws, { retentionDays: 7 });
  repo.init();
  writeFileSync(fileA, "p1\n", "utf-8");
  repo.snapshot("keep:1");
  writeFileSync(fileA, "p2\n", "utf-8");
  const ps2 = repo.snapshot("keep:2");
  const before = repo.list(20);
  const ts2 = before.find((s) => s.id === ps2)?.timestamp;
  assert.ok(ts2 && ts2 > 1_600_000_000, `snapshot timestamp should be a real unix time: ${ts2}`);
  // days<=0 is a guarded no-op (must not wipe anything).
  repo.pruneOlderThanDays(0);
  assert.equal(repo.list(20).length, before.length, "prune(0) is a no-op guard");
  // A far-future retention keeps everything (no rebuild, no loss).
  repo.pruneOlderThanDays(3650);
  assert.equal(repo.list(20).length, before.length, "generous retention keeps all snapshots");
  // workspaceKey is a stable 32-char hex (SHA-256 derived), not the old FNV-16.
  assert.match(repoMod.workspaceKey(ws), /^[0-9a-f]{32}$/, "workspaceKey is sha256-derived hex");

  console.log("snapshot e2e ok");
} finally {
  rmSync(ws, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
}
