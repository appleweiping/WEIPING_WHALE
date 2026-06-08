import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Centralized state-directory resolution for WEIPING_WHALE.
 *
 * The project was formerly DEEPSEEK_CLI and stored state under
 * `~/.deepseek-cli`. To avoid stranding existing users on rename, the new
 * primary root is `~/.weiping-whale`, but if that does not yet exist and the
 * legacy `~/.deepseek-cli` does, we keep using the legacy root so sessions,
 * config, and memory outbox stay continuous. An explicit env override always
 * wins.
 */

const PRIMARY_DIR = ".weiping-whale";
const LEGACY_DIR = ".deepseek-cli";

let cachedRoot: string | null = null;

/** Absolute path to the active state root. Cached after first resolution. */
export function stateRoot(): string {
  if (cachedRoot) return cachedRoot;

  const override = process.env.WEIPING_WHALE_HOME?.trim() || process.env.DEEPSEEK_HOME?.trim();
  if (override) {
    cachedRoot = resolve(override);
    return cachedRoot;
  }

  const primary = join(homedir(), PRIMARY_DIR);
  const legacy = join(homedir(), LEGACY_DIR);

  // Prefer primary if it exists; otherwise adopt legacy if present; else primary (fresh install).
  if (existsSync(primary)) {
    cachedRoot = primary;
  } else if (existsSync(legacy)) {
    cachedRoot = legacy;
  } else {
    cachedRoot = primary;
  }
  return cachedRoot;
}

/** A subdirectory of the state root, created on demand. */
export function stateDir(...segments: string[]): string {
  const dir = join(stateRoot(), ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionsDir(): string {
  return stateDir("sessions");
}

export function checkpointsDir(): string {
  return stateDir("sessions", "checkpoints");
}

export function snapshotsRoot(): string {
  return stateDir("snapshots");
}

export function skillsDir(): string {
  return stateDir("skills");
}

export function memoryOutboxDir(): string {
  return process.env.DEEPSEEK_MEMORY_OUTBOX_DIR || process.env.WEIPING_WHALE_MEMORY_OUTBOX_DIR
    ? resolve((process.env.WEIPING_WHALE_MEMORY_OUTBOX_DIR || process.env.DEEPSEEK_MEMORY_OUTBOX_DIR)!)
    : stateDir("memory-outbox");
}

/** For diagnostics: report which root is active and whether it is the legacy one. */
export function stateRootInfo(): { root: string; legacy: boolean } {
  const root = stateRoot();
  return { root, legacy: root.endsWith(LEGACY_DIR) };
}

/** Test-only: reset the cached root (used by self-tests that set env at runtime). */
export function _resetStateRootCache(): void {
  cachedRoot = null;
}
