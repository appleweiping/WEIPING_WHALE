import { spawn } from "child_process";
import { registerTool } from "./registry.js";

const isWindows = process.platform === "win32";

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
      const proc = spawn(isWindows ? "powershell.exe" : "bash", isWindows ? ["-NoProfile", "-Command", command] : ["-c", command], {
        timeout,
        shell: false,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      proc.on("close", (code: number | null) => {
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        resolve({
          output: output.slice(0, 50000) || `(exit code ${code})`,
          error: code !== 0,
        });
      });

      proc.on("error", (err: Error) => {
        resolve({ output: `Error: ${err.message}`, error: true });
      });
    });
  }
);
