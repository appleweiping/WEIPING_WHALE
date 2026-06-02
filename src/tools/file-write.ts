import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { registerTool } from "./registry.js";
import { createFilePatch, formatPatchCreated, getWriteMode } from "../safety/patches.js";
import { assertWritablePath } from "../safety/sandbox.js";
import { safeErrorMessage } from "../runtime/safe-text.js";

registerTool(
  "write_file",
  "Create or overwrite a file. By default this creates a patch preview that must be applied by the user.",
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
      assertWritablePath(abs);
      if (getWriteMode() === "preview") {
        const patch = createFilePatch("write", abs, content);
        return { output: formatPatchCreated(patch) };
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      return { output: `Written ${content.length} chars to ${abs}` };
    } catch (err: any) {
      return { output: `Error: ${safeErrorMessage(err)}`, error: true };
    }
  }
);

registerTool(
  "edit_file",
  "Replace an exact string in a file. By default this creates a patch preview that must be applied by the user.",
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
      assertWritablePath(abs);
      const content = readFileSync(abs, "utf-8");
      if (!content.includes(old_string)) {
        return { output: "old_string not found in file", error: true };
      }
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        return { output: `old_string found ${count} times; must be unique`, error: true };
      }
      const updated = content.replace(old_string, new_string);
      if (getWriteMode() === "preview") {
        const patch = createFilePatch("edit", abs, updated);
        return { output: formatPatchCreated(patch) };
      }
      writeFileSync(abs, updated, "utf-8");
      return { output: `Edited ${abs}` };
    } catch (err: any) {
      return { output: `Error: ${safeErrorMessage(err)}`, error: true };
    }
  }
);
