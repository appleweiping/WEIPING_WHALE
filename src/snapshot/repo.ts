/**
 * snapshot/repo.ts — Side-git workspace checkpointing for WEIPING_WHALE.
 *
 * Ported from CodeWhale's snapshot subsystem (Rust). The key safety invariant:
 * snapshots live in a SEPARATE git repository under the state root, and every
 * git invocation passes BOTH `--git-dir` (the side repo) AND `--work-tree`
 * (the user's workspace). The user's own `.git` is therefore never touched.
 *
 * A snapshot is a full tree commit created via `git add -A` -> `git write-tree`
 * -> `git commit-tree` -> `git update-ref`, which bypasses hooks and is fast and
 * deterministic. Restore is `git checkout <sha> -- :/` plus deletion of files
 * that existed in the snapshot's parent state but not the target.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { snapshotsRoot } from "../runtime/paths.js";

export interface Snapshot {
  id: string; // git commit SHA
  label: string; // e.g. "pre-turn:42"
  timestamp: number; // unix seconds
}

export interface SnapshotInitResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_MAX_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_RETENTION_DAYS = 7;

/** 64-bit FNV-1a hash of a string, returned as hex. Deterministic, non-crypto. */
export function fnv1a(input: string): string {
  // Use BigInt for 64-bit arithmetic to match the Rust implementation.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Built-in exclude patterns written to the side repo's info/exclude. */
const BUILTIN_EXCLUDES = [
  // Node
  "node_modules/", ".npm/", ".pnpm-store/", ".yarn/", ".bun/",
  // Rust
  "target/", ".cargo/", "vendor/",
  // Python
  "__pycache__/", ".venv/", "venv/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/",
  // Build / binary artifacts
  "*.exe", "*.dll", "*.o", "*.class", "*.wasm", "*.so", "*.dylib",
  // Media
  "*.mp4", "*.mov", "*.mp3", "*.wav", "*.avi", "*.mkv",
  // VCS / misc
  ".DS_Store",
];

export class SnapshotRepo {
  readonly workspace: string;
  readonly gitDir: string;
  private available = false;
  private disabledReason?: string;
  private maxWorkspaceBytes: number;
  private retentionDays: number;

  constructor(workspace: string, opts: { maxWorkspaceBytes?: number; retentionDays?: number } = {}) {
    this.workspace = resolve(workspace);
    this.maxWorkspaceBytes = opts.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const projectHash = fnv1a(this.workspace);
    this.gitDir = join(snapshotsRoot(), projectHash, ".git");
  }

  isAvailable(): boolean {
    return this.available;
  }

  reason(): string | undefined {
    return this.disabledReason;
  }

  /** Raw git invocation against the side repo + user workspace. Never throws. */
  private git(args: string[], timeoutMs = 60000): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(
      "git",
      ["--git-dir", this.gitDir, "--work-tree", this.workspace, ...args],
      { cwd: this.workspace, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      code: result.status ?? (result.error ? -1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error?.message ?? ""),
    };
  }

  /** Initialize the side repo. Returns ok=false (non-fatal) if git missing or workspace too large. */
  init(): SnapshotInitResult {
    // git present?
    const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
    if ((probe.status ?? -1) !== 0) {
      this.disabledReason = "git not found on PATH";
      return { ok: false, reason: this.disabledReason };
    }

    const fresh = !existsSync(this.gitDir);
    if (fresh) {
      // Size guard before first init.
      const size = estimateWorkspaceSize(this.workspace, this.maxWorkspaceBytes);
      if (size > this.maxWorkspaceBytes) {
        this.disabledReason = `workspace exceeds snapshot size cap (${(size / 1e9).toFixed(1)} GB > ${(this.maxWorkspaceBytes / 1e9).toFixed(1)} GB)`;
        return { ok: false, reason: this.disabledReason };
      }
      mkdirSync(this.gitDir, { recursive: true });
      const initRes = this.git(["init", "-q"]);
      if (initRes.code !== 0) {
        this.disabledReason = `git init failed: ${initRes.stderr.trim()}`;
        return { ok: false, reason: this.disabledReason };
      }
      // Config: no autocrlf (byte fidelity), no auto-gc mid-turn, quiet identity.
      this.git(["config", "core.autocrlf", "false"]);
      this.git(["config", "gc.auto", "0"]);
      this.git(["config", "user.email", "snapshots@weiping-whale.local"]);
      this.git(["config", "user.name", "weiping-whale-snapshots"]);
      this.git(["config", "commit.gpgsign", "false"]);
    }

    // (Re)write the exclude file every init — cheap and keeps it current.
    try {
      const infoDir = join(this.gitDir, "info");
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(join(infoDir, "exclude"), BUILTIN_EXCLUDES.join("\n") + "\n", "utf-8");
    } catch {
      // non-fatal
    }

    this.available = true;
    if (!fresh) this.pruneOlderThanDays(this.retentionDays);
    return { ok: true };
  }

  /**
   * Take a snapshot of the current workspace state. Returns the new commit SHA,
   * or null if snapshots are unavailable or the operation failed (non-fatal).
   */
  snapshot(label: string): string | null {
    if (!this.available) return null;

    const add = this.git(["add", "-A"]);
    if (add.code !== 0) return null;

    const writeTree = this.git(["write-tree"]);
    if (writeTree.code !== 0) return null;
    const tree = writeTree.stdout.trim();
    if (!tree) return null;

    // Parent = current HEAD if any.
    const head = this.git(["rev-parse", "--verify", "-q", "HEAD"]);
    const parent = head.code === 0 ? head.stdout.trim() : "";

    const commitArgs = ["commit-tree", tree, "-m", label];
    if (parent) commitArgs.push("-p", parent);
    const commit = this.git(commitArgs);
    if (commit.code !== 0) return null;
    const sha = commit.stdout.trim();
    if (!sha) return null;

    const update = this.git(["update-ref", "HEAD", sha]);
    if (update.code !== 0) return null;

    return sha;
  }

  /** List snapshots newest-first, parsed from the side repo's git log. */
  list(limit = 50): Snapshot[] {
    if (!this.available) return [];
    const log = this.git(["log", "--pretty=format:%H%x09%at%x09%s", `-n`, String(limit)]);
    if (log.code !== 0) return [];
    const out: Snapshot[] = [];
    for (const line of log.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [id, at, ...rest] = line.split("\t");
      if (!id) continue;
      out.push({ id, timestamp: Number(at) || 0, label: rest.join("\t") });
    }
    return out;
  }

  /** True if the workspace already byte-matches the given snapshot. */
  matches(sha: string): boolean {
    if (!this.available) return false;
    const diff = this.git(["diff", "--quiet", sha, "--", ":/"]);
    return diff.code === 0;
  }

  /**
   * Restore the workspace to the given snapshot tree. Files present in the
   * current HEAD tree but absent from the target are deleted.
   */
  restore(sha: string): { ok: boolean; error?: string } {
    if (!this.available) return { ok: false, error: this.disabledReason ?? "snapshots unavailable" };

    const headBefore = this.git(["rev-parse", "--verify", "-q", "HEAD"]);
    const before = headBefore.code === 0 ? headBefore.stdout.trim() : "";

    const checkout = this.git(["checkout", sha, "--", ":/"]);
    if (checkout.code !== 0) return { ok: false, error: checkout.stderr.trim() || "git checkout failed" };

    // Delete files that existed before but not in the restored tree.
    if (before && before !== sha) {
      const oldFiles = this.lsTree(before);
      const newFiles = new Set(this.lsTree(sha));
      for (const f of oldFiles) {
        if (!newFiles.has(f)) {
          try {
            rmSync(join(this.workspace, f), { force: true });
          } catch {
            // ignore
          }
        }
      }
    }
    // Point HEAD at the restored snapshot so subsequent diffs are correct.
    this.git(["update-ref", "HEAD", sha]);
    return { ok: true };
  }

  private lsTree(sha: string): string[] {
    const res = this.git(["ls-tree", "-r", "--name-only", "-z", sha]);
    if (res.code !== 0) return [];
    return res.stdout.split("\0").filter((s) => s.length > 0);
  }

  /** Prune snapshots older than N days. Best-effort. */
  pruneOlderThanDays(days: number): void {
    if (!this.available || days <= 0) return;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const snaps = this.list(1000);
    const survivors = snaps.filter((s) => s.timestamp > cutoff);
    if (survivors.length === snaps.length) return; // nothing to prune
    if (survivors.length === 0) {
      // All old: wipe refs to start fresh.
      this.git(["update-ref", "-d", "HEAD"]);
      try {
        rmSync(join(this.gitDir, "refs", "heads"), { recursive: true, force: true });
        rmSync(join(this.gitDir, "packed-refs"), { force: true });
      } catch {
        // ignore
      }
      return;
    }
    // Re-root HEAD at the oldest survivor and gc the rest.
    const oldestSurvivor = survivors[survivors.length - 1];
    this.git(["update-ref", "HEAD", oldestSurvivor.id]);
    this.git(["reflog", "expire", "--expire=now", "--all"]);
    this.git(["gc", "--prune=now", "-q"]);
  }
}

/** Estimate workspace size, stopping early once the cap is exceeded. */
function estimateWorkspaceSize(root: string, cap: number): number {
  let total = 0;
  const skip = new Set(["node_modules", ".git", "target", ".venv", "venv", "vendor", "__pycache__"]);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        total += st.size;
        if (total > cap) return total; // early exit
      }
    }
  }
  return total;
}
