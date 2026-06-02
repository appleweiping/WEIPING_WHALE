/**
 * monitor.ts — Process/file monitoring for DeepSeek CLI
 *
 * Spawns background processes and streams their output as events.
 * Commands: /monitor start <cmd> | /monitor list | /monitor stop <id> | /monitor logs <id>
 */
import { spawn, type ChildProcess } from "child_process";
import { safeErrorMessage } from "../runtime/safe-text.js";
import { classifyShellCommand, createShellApproval, getApprovalMode } from "../safety/approval.js";

export interface MonitorEntry {
  id: string;
  command: string;
  started: string;
  status: "running" | "stopped" | "error";
  exitCode?: number;
  events: MonitorEvent[];
  process?: ChildProcess;
}

export interface MonitorEvent {
  ts: string;
  type: "stdout" | "stderr" | "exit" | "error";
  data: string;
}

const monitors = new Map<string, MonitorEntry>();
let monitorIdCounter = 1;

function newId(): string {
  return `m${monitorIdCounter++}`;
}

export function monitorStart(
  command: string,
  timeoutMs = 600_000,
  onEvent?: (id: string, event: MonitorEvent) => void
): MonitorEntry {
  const id = newId();
  const entry: MonitorEntry = {
    id,
    command,
    started: new Date().toISOString(),
    status: "running",
    events: [],
  };

  const child = spawn(command, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    addEvent("error", `Monitor timed out after ${timeoutMs}ms`);
    child.kill();
  }, timeoutMs);

  entry.process = child;
  monitors.set(id, entry);

  const addEvent = (type: MonitorEvent["type"], data: string) => {
    const event: MonitorEvent = { ts: new Date().toISOString(), type, data: data.trimEnd() };
    entry.events.push(event);
    // Keep last 500 events
    if (entry.events.length > 500) entry.events.shift();
    onEvent?.(id, event);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) addEvent("stdout", line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) addEvent("stderr", line);
    }
  });

  child.on("exit", (code) => {
    clearTimeout(timer);
    entry.status = code === 0 ? "stopped" : "error";
    entry.exitCode = code ?? undefined;
    addEvent("exit", `Process exited with code ${code}`);
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    entry.status = "error";
    addEvent("error", safeErrorMessage(err));
  });

  return entry;
}

export function monitorStop(id: string): boolean {
  const entry = monitors.get(id);
  if (!entry) return false;
  entry.process?.kill("SIGTERM");
  entry.status = "stopped";
  return true;
}

export function monitorList(): MonitorEntry[] {
  return Array.from(monitors.values());
}

export function monitorLogs(id: string, tail = 20): MonitorEvent[] {
  const entry = monitors.get(id);
  if (!entry) return [];
  return entry.events.slice(-tail);
}

export function monitorGet(id: string): MonitorEntry | undefined {
  return monitors.get(id);
}

export function formatMonitorList(): string {
  const list = monitorList();
  if (list.length === 0) return "  No active monitors.";
  return list
    .map((m) => {
      const icon = m.status === "running" ? "\x1b[32m●\x1b[0m" : m.status === "error" ? "\x1b[31m✗\x1b[0m" : "\x1b[2m○\x1b[0m";
      const events = m.events.length;
      return `  ${icon} [${m.id}] ${m.command}  (${m.status}, ${events} events)`;
    })
    .join("\n");
}

export function formatMonitorLogs(id: string, tail = 20): string {
  const entry = monitors.get(id);
  if (!entry) return `  No monitor: ${id}`;
  const events = monitorLogs(id, tail);
  if (events.length === 0) return `  [${id}] No output yet.`;
  const TYPE_COLOR: Record<string, string> = {
    stdout: "\x1b[0m",
    stderr: "\x1b[33m",
    exit: "\x1b[2m",
    error: "\x1b[31m",
  };
  const RESET = "\x1b[0m";
  return events
    .map((e) => {
      const color = TYPE_COLOR[e.type] ?? "";
      const ts = e.ts.slice(11, 19);
      return `  \x1b[2m${ts}\x1b[0m ${color}${e.data}${RESET}`;
    })
    .join("\n");
}

export function handleMonitorCommand(
  arg: string,
  onEvent?: (id: string, event: MonitorEvent) => void
): string {
  const parts = arg.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "list";
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "start":
    case "run": {
      if (!rest) return "Usage: /monitor start <command>";
      const risk = classifyShellCommand(rest);
      if (risk.level === "blocked") return `  Blocked dangerous monitor command: ${risk.reason}`;
      const mode = getApprovalMode();
      if (risk.level === "approval_required" && mode === "never") {
        return [
          `  Monitor command not run: ${risk.reason}`,
          "  Current approval mode is never; risky monitor commands are disabled.",
        ].join("\n");
      }
      if (risk.level === "approval_required" && mode !== "auto") {
        const approval = createShellApproval(rest, 600_000, `monitor command: ${risk.reason}`);
        return [
          `  Monitor approval required: ${approval.id}`,
          `  Reason: ${risk.reason}`,
          `  Review with /approvals, run once with /approve ${approval.id}, or reject with /deny ${approval.id}.`,
        ].join("\n");
      }
      const entry = monitorStart(rest, 600_000, onEvent);
      return `  \x1b[32m●\x1b[0m [${entry.id}] Started: ${rest}\n  Use /monitor logs ${entry.id} to see output`;
    }
    case "stop": {
      if (!rest) return "Usage: /monitor stop <id>";
      return monitorStop(rest) ? `  Stopped monitor ${rest}` : `  No monitor: ${rest}`;
    }
    case "logs":
    case "tail": {
      const id = parts[1];
      const tail = parts[2] ? Number(parts[2]) : 20;
      if (!id) return "Usage: /monitor logs <id> [lines]";
      return `\n${formatMonitorLogs(id, tail)}\n`;
    }
    case "list":
    case "ls":
    case "": {
      return `\nMonitors\n${formatMonitorList()}\n`;
    }
    case "clear": {
      let cleared = 0;
      for (const [id, entry] of monitors) {
        if (entry.status !== "running") { monitors.delete(id); cleared++; }
      }
      return `  Cleared ${cleared} stopped monitor(s)`;
    }
    default:
      return "Usage: /monitor <start|stop|logs|list|clear> [args]";
  }
}
