/**
 * skills/install.ts — install a skill from GitHub into the global skills dir.
 *
 * Uses `git clone --depth 1` (no extra tar dependency). Validates that the
 * cloned tree contains a SKILL.md, records provenance in `.installed-from`, and
 * refuses sources that don't look like `owner/repo` or a GitHub URL.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { skillsDir } from "../runtime/paths.js";

export interface InstallResult {
  ok: boolean;
  name?: string;
  path?: string;
  error?: string;
}

/** Parse a source spec into a clone URL + a default install name. */
export function resolveSource(spec: string): { url: string; name: string } | null {
  const s = spec.trim();
  // github:owner/repo  or  owner/repo
  const shorthand = s.replace(/^github:/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(shorthand)) {
    const [, repo] = shorthand.split("/");
    return { url: `https://github.com/${shorthand}.git`, name: repo.replace(/\.git$/, "") };
  }
  // full https URL
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(s)) {
    const name = s.replace(/\.git$/, "").split("/").pop()!;
    return { url: s.endsWith(".git") ? s : s + ".git", name };
  }
  return null;
}

/** Install a skill from GitHub. Returns the installed skill name + path. */
export function installSkill(spec: string, opts: { name?: string } = {}): InstallResult {
  const resolved = resolveSource(spec);
  if (!resolved) {
    return { ok: false, error: `unrecognized skill source '${spec}'. Use owner/repo or a github.com URL.` };
  }
  // Sanitize the install name (no traversal, no separators).
  const installName = (opts.name || resolved.name).replace(/[^\w.-]/g, "_");
  if (!installName || installName === "." || installName === "..") {
    return { ok: false, error: "invalid skill name" };
  }

  const dest = join(skillsDir(), installName);
  const tmp = join(skillsDir(), `.tmp-${installName}-${Date.now()}`);

  // Clone into a temp dir first.
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "--quiet", resolved.url, tmp],
    { encoding: "utf8", timeout: 120000 },
  );
  if ((clone.status ?? -1) !== 0) {
    safeRm(tmp);
    return { ok: false, error: `git clone failed: ${(clone.stderr || clone.error?.message || "").trim().slice(0, 200)}` };
  }

  // Validate: must contain a SKILL.md somewhere shallow, and no path escapes.
  const skillMd = findShallowSkillMd(tmp, 0);
  if (!skillMd) {
    safeRm(tmp);
    return { ok: false, error: "no SKILL.md found in the cloned repository" };
  }

  // Drop the cloned .git to keep installs clean, then move into place.
  safeRm(join(tmp, ".git"));
  writeFileSync(
    join(tmp, ".installed-from"),
    JSON.stringify({ spec, url: resolved.url, installed_at: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  if (existsSync(dest)) safeRm(dest);
  mkdirSync(skillsDir(), { recursive: true });
  try {
    renameSync(tmp, dest);
  } catch {
    safeRm(tmp);
    return { ok: false, error: "failed to move skill into place" };
  }

  return { ok: true, name: installName, path: dest };
}

function findShallowSkillMd(dir: string, depth: number): string | null {
  if (depth > 3) return null;
  const direct = join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === ".git") continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        const found = findShallowSkillMd(full, depth + 1);
        if (found) return found;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function safeRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
