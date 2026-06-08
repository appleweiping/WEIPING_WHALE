/**
 * tools/snapshot-tool.ts — exposes `revert_turn` to the model and holds the
 * active SnapshotManager for the session.
 *
 * The tool registry is module-global, so we keep a module-level reference to
 * the active manager (set once per session in index.ts) rather than threading
 * it through every tool handler.
 */
import { registerTool } from "./registry.js";
import type { SnapshotManager } from "../snapshot/manager.js";

let active: SnapshotManager | null = null;

export function setActiveSnapshotManager(manager: SnapshotManager | null): void {
  active = manager;
}

export function getActiveSnapshotManager(): SnapshotManager | null {
  return active;
}

registerTool(
  "revert_turn",
  "Revert the workspace files to the state captured just before a turn began. " +
    "Use this to undo file changes you made in a previous turn when the user asks " +
    "to undo, roll back, or discard your last edits. Restores files only; it does " +
    "not alter the conversation. Omit 'turn' to revert the most recent turn.",
  {
    type: "object",
    properties: {
      turn: {
        type: "number",
        description: "Optional turn number to revert to its pre-turn state. Defaults to the most recent turn.",
      },
    },
  },
  async ({ turn }) => {
    if (!active) {
      return { output: "Snapshots are not enabled for this session; cannot revert.", error: true };
    }
    const result = active.revertTurn(typeof turn === "number" ? turn : undefined);
    if (!result.ok) {
      return { output: `revert_turn failed: ${result.error}`, error: true };
    }
    return { output: `Reverted workspace to pre-turn snapshot ${result.restored?.slice(0, 12)}.` };
  },
);
