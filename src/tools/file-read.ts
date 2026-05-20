import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { registerTool } from "./registry.js";

registerTool(
  "read_file",
  "Read the contents of a file. Returns the file content with line numbers.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      offset: { type: "number", description: "Start line (0-indexed)" },
      limit: { type: "number", description: "Max lines to read (default 200)" },
    },
    required: ["path"],
  },
  async ({ path, offset = 0, limit = 200 }) => {
    const abs = resolve(path);
    if (!existsSync(abs)) {
      return { output: `File not found: ${abs}`, error: true };
    }
    try {
      const content = readFileSync(abs, "utf-8");
      const lines = content.split("\n");
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
      const info =
        lines.length > offset + limit
          ? `\n... (${lines.length - offset - limit} more lines)`
          : "";
      return { output: numbered + info };
    } catch (err: any) {
      return { output: `Error reading file: ${err.message}`, error: true };
    }
  }
);
