import fg from "fast-glob";
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { registerTool } from "./registry.js";

registerTool(
  "glob",
  "Find files matching a glob pattern. Returns matching file paths.",
  {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts')" },
      cwd: { type: "string", description: "Directory to search in (default: workspace)" },
    },
    required: ["pattern"],
  },
  async ({ pattern, cwd }) => {
    try {
      const files = await fg(pattern, {
        cwd: cwd || process.cwd(),
        ignore: ["**/node_modules/**", "**/.git/**"],
        onlyFiles: true,
        absolute: true,
      });
      if (files.length === 0) return { output: "No files matched" };
      return { output: files.slice(0, 100).join("\n") };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, error: true };
    }
  }
);

registerTool(
  "grep",
  "Search file contents for a regex pattern using ripgrep. Returns matching lines.",
  {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file to search (default: cwd)" },
      glob: { type: "string", description: "File glob filter (e.g. '*.ts')" },
    },
    required: ["pattern"],
  },
  async ({ pattern, path, glob: fileGlob }) => {
    return new Promise((resolve) => {
      const args = ["--no-heading", "--line-number", "--color=never", "-e", pattern];
      if (fileGlob) args.push("--glob", fileGlob);
      args.push(path || ".");

      const proc = spawn("rg", args, { timeout: 10000 });
      let output = "";

      proc.stdout?.on("data", (d) => (output += d.toString()));
      proc.stderr?.on("data", (d) => (output += d.toString()));

      proc.on("close", () => {
        if (!output.trim()) {
          resolve({ output: "No matches found" });
        } else {
          resolve({ output: output.slice(0, 30000) });
        }
      });

      proc.on("error", () => {
        fallbackGrep(pattern, path || ".", fileGlob)
          .then(resolve)
          .catch((err: any) => resolve({ output: `grep fallback failed: ${err.message}`, error: true }));
      });
    });
  }
);

async function fallbackGrep(pattern: string, searchPath: string, fileGlob?: string) {
  const regex = new RegExp(pattern);
  const files = await fg(fileGlob || "**/*", {
    cwd: searchPath,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    absolute: true,
  });
  const matches: string[] = [];
  for (const file of files.slice(0, 2000)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (regex.test(lines[index])) matches.push(`${file}:${index + 1}:${lines[index]}`);
      if (matches.length >= 300) break;
    }
    if (matches.length >= 300) break;
  }
  return { output: matches.length ? matches.join("\n").slice(0, 30000) : "No matches found" };
}
