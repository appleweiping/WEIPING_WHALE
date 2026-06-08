import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = mkdtempSync(join(tmpdir(), "ww-skills-state-"));
process.env.WEIPING_WHALE_HOME = stateHome;

const sk = await import("../src/skills/index.ts");
const inst = await import("../src/skills/install.ts");

const ws = mkdtempSync(join(tmpdir(), "ww-skills-ws-"));
try {
  // Skill A: frontmatter with name + description.
  const aDir = join(ws, ".weiping-whale", "skills", "alpha");
  mkdirSync(aDir, { recursive: true });
  writeFileSync(join(aDir, "SKILL.md"), "---\nname: alpha-tool\ndescription: does alpha things\n---\n# Alpha\nbody", "utf-8");

  // Skill B: no frontmatter -> falls back to first heading.
  const bDir = join(ws, ".weiping-whale", "skills", "beta");
  mkdirSync(bDir, { recursive: true });
  writeFileSync(join(bDir, "SKILL.md"), "# Beta Helper\nsome content", "utf-8");

  const found = sk.discoverSkills(ws);
  const names = found.map((s) => s.name);
  // Note: discovery also includes real ~/.claude and ~/.agents skills (cross-tool
  // interop, by design), so assert our workspace skills are present rather than
  // exact equality.
  assert.ok(names.includes("alpha-tool"), "discovered alpha-tool");
  assert.ok(names.includes("Beta Helper"), "discovered Beta Helper (heading fallback)");
  const alpha = found.find((s) => s.name === "alpha-tool");
  assert.equal(alpha.description, "does alpha things", "frontmatter description parsed");

  // Prompt block contains alpha, and includes file paths. (Budget may truncate
  // when many global skills exist, so just check structure + our entry if shown.)
  const block = sk.renderSkillsBlock([alpha, found.find((s) => s.name === "Beta Helper")]);
  assert.match(block, /## Skills/, "has header");
  assert.match(block, /alpha-tool — does alpha things/, "lists alpha with desc");
  assert.match(block, /file: /, "includes file path for progressive disclosure");

  // Empty -> undefined block.
  assert.equal(sk.renderSkillsBlock([]), undefined, "no skills -> no block");

  // Precedence: a workspace skill named alpha-tool shadows a global one.
  const globalAlpha = join(stateHome, "skills", "alpha");
  mkdirSync(globalAlpha, { recursive: true });
  writeFileSync(join(globalAlpha, "SKILL.md"), "---\nname: alpha-tool\ndescription: GLOBAL version\n---\n", "utf-8");
  const found2 = sk.discoverSkills(ws);
  const alpha2 = found2.find((s) => s.name === "alpha-tool");
  assert.equal(alpha2.description, "does alpha things", "workspace skill wins over global");

  // Source resolution for install (no network).
  assert.deepEqual(inst.resolveSource("Hmbown/CodeWhale"), { url: "https://github.com/Hmbown/CodeWhale.git", name: "CodeWhale" });
  assert.deepEqual(inst.resolveSource("github:owner/repo"), { url: "https://github.com/owner/repo.git", name: "repo" });
  assert.equal(inst.resolveSource("https://github.com/a/b").url, "https://github.com/a/b.git");
  assert.equal(inst.resolveSource("not a source"), null, "garbage source rejected");
  assert.equal(inst.resolveSource("../../etc/passwd"), null, "traversal-y source rejected");

  console.log("skills e2e ok");
} finally {
  rmSync(ws, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
}
