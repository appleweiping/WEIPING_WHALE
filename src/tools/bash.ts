import { spawn } from "child_process";
import { registerTool } from "./registry.js";
import {
  classifyShellCommand,
  createShellApproval,
  getApprovalMode,
} from "../safety/approval.js";
import type { ToolResult } from "./registry.js";

const isWindows = process.platform === "win32";

registerTool(
  "execute_bash",
  "Execute a shell command and return stdout/stderr. Risky commands are held for explicit user approval.",
  {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in ms (default 30000)" },
    },
    required: ["command"],
  },
  async ({ command, timeout = 30000 }) => {
    const risk = classifyShellCommand(command);
    if (risk.level === "blocked") {
      return { output: `Blocked dangerous shell command: ${risk.reason}`, error: true };
    }
    if (risk.level === "approval_required" && getApprovalMode() !== "auto") {
      const approval = createShellApproval(command, timeout, risk.reason);
      const mode = getApprovalMode();
      return {
        output: [
          `Shell approval required: ${approval.id}`,
          `Reason: ${risk.reason}`,
          mode === "never" ? "Current approval mode is never; command will not run." : `Review with /approvals, run with /approve ${approval.id}, or reject with /deny ${approval.id}.`,
          "",
          command,
        ].join("\n"),
        error: true,
      };
    }
    return runShellCommand(command, timeout);
  }
);

export async function runShellCommand(command: string, timeout = 30000): Promise<ToolResult> {
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
