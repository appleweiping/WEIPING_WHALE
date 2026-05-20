import { spawn } from "child_process";
import { registerTool } from "./registry.js";

registerTool(
  "execute_bash",
  "Execute a shell command and return stdout/stderr. Use for running programs, git, npm, etc.",
  {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in ms (default 30000)" },
    },
    required: ["command"],
  },
  async ({ command, timeout = 30000 }) => {
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", command], {
        timeout,
        maxBuffer: 1024 * 1024,
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));

      proc.on("close", (code) => {
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        resolve({
          output: output.slice(0, 50000) || `(exit code ${code})`,
          error: code !== 0,
        });
      });

      proc.on("error", (err) => {
        resolve({ output: `Error: ${err.message}`, error: true });
      });
    });
  }
);
