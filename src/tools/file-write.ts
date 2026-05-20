import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { registerTool } from "./registry.js";

registerTool(
  "write_file",
  "Create or overwrite a file with the given content.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      content: { type: "string", description: "File content to write" },
    },
    required: ["path", "content"],
  },
  async ({ path, content }) => {
    const abs = resolve(path);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      return { output: `Written ${content.length} chars to ${abs}` };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, error: true };
    }
  }
);

registerTool(
  "edit_file",
  "Replace an exact string in a file with a new string. The old_string must match exactly.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async ({ path, old_string, new_string }) => {
    const abs = resolve(path);
    if (!existsSync(abs)) {
      return { output: `File not found: ${abs}`, error: true };
    }
    try {
      const content = readFileSync(abs, "utf-8");
      if (!content.includes(old_string)) {
        return { output: "old_string not found in file", error: true };
      }
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        return { output: `old_string found ${count} times — must be unique`, error: true };
      }
      writeFileSync(abs, content.replace(old_string, new_string), "utf-8");
      return { output: `Edited ${abs}` };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, error: true };
    }
  }
);
