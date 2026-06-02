import { spawn } from "child_process";
import { registerTool } from "./registry.js";
import {
  classifyShellCommand,
  createShellApproval,
  getApprovalMode,
} from "../safety/approval.js";
import type { ToolResult } from "./registry.js";
import { safeErrorMessage } from "../runtime/safe-text.js";

const isWindows = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

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
  async ({ command, timeout = DEFAULT_TIMEOUT_MS }) => {
    const normalizedTimeout = normalizeTimeout(timeout);
    const risk = classifyShellCommand(command);
    if (risk.level === "blocked") {
      return { output: `Blocked dangerous shell command: ${risk.reason}`, error: true };
    }
    const mode = getApprovalMode();
    if (risk.level === "approval_required" && mode === "never") {
      return {
        output: [
          `Shell command not run: ${risk.reason}`,
          "Current approval mode is never; risky shell commands are disabled.",
          "",
          command,
        ].join("\n"),
        error: true,
      };
    }
    if (risk.level === "approval_required" && mode !== "auto") {
      const approval = createShellApproval(command, normalizedTimeout, risk.reason);
      return {
        output: [
          `Shell approval required: ${approval.id}`,
          `Reason: ${risk.reason}`,
          `Review with /approvals, run with /approve ${approval.id}, or reject with /deny ${approval.id}.`,
          "",
          command,
        ].join("\n"),
        error: true,
      };
    }
    return runShellCommand(command, normalizedTimeout);
  }
);

export async function runShellCommand(command: string, timeout = DEFAULT_TIMEOUT_MS): Promise<ToolResult> {
  const normalizedTimeout = normalizeTimeout(timeout);
  return new Promise((resolve) => {
      const proc = spawn(isWindows ? "powershell.exe" : "bash", isWindows ? ["-NoProfile", "-Command", command] : ["-c", command], {
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, normalizedTimeout);

      proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (timedOut) {
          resolve({
            output: `${output.slice(0, 50000)}\n[timeout]\nCommand timed out after ${normalizedTimeout}ms`.trim(),
            error: true,
          });
          return;
        }
        resolve({
          output: output.slice(0, 50000) || `(exit code ${code})`,
          error: code !== 0,
        });
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({ output: `Error: ${safeErrorMessage(err)}`, error: true });
      });
  });
}

function normalizeTimeout(timeout: unknown): number {
  const value = Number(timeout);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 1000), MAX_TIMEOUT_MS);
}
