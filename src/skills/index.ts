/**
 * skills/index.ts — file-based skills for WEIPING_WHALE.
 *
 * Skills are folders containing a SKILL.md with YAML frontmatter (name +
 * optional description). They are discovered from workspace-local and global
 * roots, injected into the system prompt as a compact catalog (progressive
 * disclosure — the model opens a skill's file on demand), and can be installed
 * from GitHub via `git clone`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import { skillsDir } from "../runtime/paths.js";

export interface Skill {
  name: string;
  description: string;
  path: string; // absolute path to SKILL.md
  source: string; // discovery root label
}

const MAX_DEPTH = 8;
const PROMPT_BUDGET = 12000; // chars for the whole skills block

/** Discovery roots, highest precedence first. */
export function skillRoots(workspace: string): { dir: string; label: string }[] {
  const roots: { dir: string; label: string }[] = [
    { dir: join(workspace, ".weiping-whale", "skills"), label: "workspace" },
    { dir: join(workspace, ".agents", "skills"), label: "workspace:.agents" },
    { dir: join(workspace, ".claude", "skills"), label: "workspace:.claude" },
    { dir: skillsDir(), label: "global" },
    { dir: join(homedir(), ".agents", "skills"), label: "global:.agents" },
    { dir: join(homedir(), ".claude", "skills"), label: "global:.claude" },
  ];
  return roots;
}

/** Discover all skills across roots. First occurrence of a name wins (precedence). */
export function discoverSkills(workspace: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(workspace)) {
    if (!existsSync(root.dir)) continue;
    for (const md of findSkillFiles(root.dir, 0)) {
      const parsed = parseSkillFile(md, root.label);
      if (parsed && !byName.has(parsed.name)) byName.set(parsed.name, parsed);
    }
  }
  return [...byName.values()];
}

/** Recursively find SKILL.md files, stopping descent once one is found in a dir. */
function findSkillFiles(dir: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  const direct = join(dir, "SKILL.md");
  if (existsSync(direct)) return [direct]; // stop descending here
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) out.push(...findSkillFiles(full, depth + 1));
    } catch {
      // ignore
    }
  }
  return out;
}

/** Parse a SKILL.md: YAML frontmatter (name/description) or first heading fallback. */
export function parseSkillFile(path: string, source: string): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const fm = extractFrontmatter(raw);
  let name: string | undefined;
  let description = "";
  if (fm) {
    try {
      const data = yaml.load(fm) as any;
      if (data && typeof data === "object") {
        if (typeof data.name === "string") name = data.name.trim();
        if (typeof data.description === "string") description = data.description.trim();
      }
    } catch {
      // fall through to heading fallback
    }
  }
  if (!name) {
    // Fallback: first markdown H1.
    const heading = raw.match(/^#\s+(.+)$/m);
    if (heading) name = heading[1].trim();
  }
  if (!name) {
    // Last resort: parent directory name.
    const parts = path.replace(/\\/g, "/").split("/");
    name = parts[parts.length - 2] || "skill";
  }
  return { name, description, path, source };
}

function extractFrontmatter(raw: string): string | null {
  // Leading --- ... --- block.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

/** Render the skills catalog for the system prompt, within the char budget. */
export function renderSkillsBlock(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines: string[] = ["## Skills", "Available skills (open the file to use one):"];
  let used = lines.join("\n").length;
  let shown = 0;
  for (const s of skills) {
    const desc = s.description ? ` — ${s.description}` : "";
    const line = `- ${s.name}${desc}\n  file: ${s.path}`;
    if (used + line.length + 1 > PROMPT_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const omitted = skills.length - shown;
  if (omitted > 0) lines.push(`… and ${omitted} more skill(s) omitted (prompt budget).`);
  return lines.join("\n");
}
