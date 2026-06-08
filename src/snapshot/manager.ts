/**
 * snapshot/manager.ts — Session-facing snapshot orchestration.
 *
 * Tracks per-turn snapshots so the UI can offer `/restore <id>`, `/undo`
 * (revert to the most recent snapshot that differs from the current state),
 * and a `revert_turn` tool the model can call to undo its own last turn.
 */
import { SnapshotRepo, type Snapshot } from "./repo.js";

export class SnapshotManager {
  private repo: SnapshotRepo;
  private turn = 0;
  private enabled: boolean;
  // Map of turn number -> pre-turn snapshot SHA, for revert_turn.
  private preTurnByTurn = new Map<number, string>();

  constructor(workspace: string, opts: { enabled?: boolean; retentionDays?: number } = {}) {
    this.repo = new SnapshotRepo(workspace, { retentionDays: opts.retentionDays });
    this.enabled = opts.enabled ?? true;
    if (this.enabled) {
      const res = this.repo.init();
      if (!res.ok) this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.repo.isAvailable();
  }

  reason(): string | undefined {
    return this.repo.reason();
  }

  /** Call before the model processes a user turn. Returns the SHA (or null). */
  beforeTurn(): string | null {
    if (!this.isEnabled()) return null;
    this.turn += 1;
    const sha = this.repo.snapshot(`pre-turn:${this.turn}`);
    if (sha) this.preTurnByTurn.set(this.turn, sha);
    return sha;
  }

  /** Call after a turn completes (including tool edits). */
  afterTurn(): string | null {
    if (!this.isEnabled()) return null;
    return this.repo.snapshot(`post-turn:${this.turn}`);
  }

  list(limit = 50): Snapshot[] {
    return this.repo.list(limit);
  }

  /** Restore to a snapshot by full or unique-prefix SHA. */
  restore(idOrPrefix: string): { ok: boolean; error?: string; restored?: string } {
    if (!this.isEnabled()) return { ok: false, error: this.reason() ?? "snapshots disabled" };
    const snaps = this.repo.list(1000);
    const matches = snaps.filter((s) => s.id.startsWith(idOrPrefix));
    if (matches.length === 0) return { ok: false, error: `no snapshot matching '${idOrPrefix}'` };
    if (matches.length > 1) return { ok: false, error: `ambiguous snapshot prefix '${idOrPrefix}' (${matches.length} matches)` };
    const target = matches[0];
    const res = this.repo.restore(target.id);
    return res.ok ? { ok: true, restored: target.id } : { ok: false, error: res.error };
  }

  /** Undo: restore the most recent snapshot whose tree differs from current state. */
  undo(): { ok: boolean; error?: string; restored?: string } {
    if (!this.isEnabled()) return { ok: false, error: this.reason() ?? "snapshots disabled" };
    const snaps = this.repo.list(1000);
    for (const snap of snaps) {
      if (!this.repo.matches(snap.id)) {
        const res = this.repo.restore(snap.id);
        return res.ok ? { ok: true, restored: snap.id } : { ok: false, error: res.error };
      }
    }
    return { ok: false, error: "nothing to undo (workspace matches latest snapshot)" };
  }

  /** Revert the workspace to the pre-turn state of the most recent turn. */
  revertTurn(turn?: number): { ok: boolean; error?: string; restored?: string } {
    if (!this.isEnabled()) return { ok: false, error: this.reason() ?? "snapshots disabled" };
    const target = turn ?? this.turn;
    const sha = this.preTurnByTurn.get(target);
    if (!sha) return { ok: false, error: `no pre-turn snapshot for turn ${target}` };
    const res = this.repo.restore(sha);
    return res.ok ? { ok: true, restored: sha } : { ok: false, error: res.error };
  }
}
