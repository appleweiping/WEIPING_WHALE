#!/usr/bin/env node
import { EventEmitter } from "events";
import { MODEL_PRESETS, applyRuntimeOverrides, loadConfig, type Config } from "./config.js";
import { Agent } from "./agent.js";
import { MCPManager } from "./mcp/manager.js";
import { getToolDefs } from "./tools/registry.js";
import { formatPatchList, applyFilePatch, rejectFilePatch } from "./safety/patches.js";
import { getApprovalMode, listShellApprovals, rejectShellApproval, setApprovalMode, takeShellApproval } from "./safety/approval.js";
import { getWriteMode, setWriteMode } from "./safety/patches.js";
import { getSandboxMode, setSandboxMode } from "./safety/sandbox.js";
import { runShellCommand } from "./tools/bash.js";
import { createSessionId, formatSessionInfo, listSessions, loadSession, saveSession } from "./session.js";
import { saveSessionMemory, type SessionMemoryResult } from "./memory.js";
import {
  banner,
  createRL,
  printAssistant,
  printError,
  printHelp,
  printInfo,
  printRuntimeUpdated,
  printStatus,
  printThinking,
  printToolEnd,
  printToolStart,
  type SlashMenuItem,
  TerminalLineReader,
  type SlashMenuResult,
} from "./ui/terminal.js";

// Register built-in tools
import "./tools/bash.js";
import "./tools/file-read.js";
import "./tools/file-write.js";
import "./tools/glob.js";

const VERSION = "0.1.0";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.includes("--self-test-editor")) {
    runEditorSelfTest();
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let cwdOverride: string | undefined;
  try {
    cwdOverride = readFlag(args, "--cwd") ?? readFlag(args, "--workspace");
    if (cwdOverride) changeDirectory(cwdOverride);
  } catch (err: any) {
    printCliError(err.message, json);
    process.exit(1);
  }

  if (args.includes("--models")) {
    printModels(json);
    process.exit(0);
  }

  const resumeSessionId = readFlag(args, "--resume");
  const sessionId = readFlag(args, "--session") ?? resumeSessionId ?? createSessionId();
  const task = readFlag(args, "-t") ?? readFlag(args, "--task") ?? readPositionalTask(args);

  const config = loadConfig();
  if (!cwdOverride && config.agent.workspace && config.agent.workspace !== ".") {
    try {
      changeDirectory(config.agent.workspace);
    } catch (err: any) {
      printCliError(err.message, json);
      process.exit(1);
    }
  }
  try {
    applyRuntimeOverrides(config, parseRuntimeArgs(args));
  } catch (err: any) {
    printCliError(err.message, json);
    process.exit(1);
  }

  if (args.includes("--doctor")) {
    const doctorMcpManager = new MCPManager();
    if (Object.keys(config.mcp_servers).length > 0) {
      await doctorMcpManager.connectAll(config.mcp_servers);
    }
    printDoctor(config, json, doctorMcpManager);
    doctorMcpManager.disconnectAll();
    process.exit(config.llm.api_key ? 0 : 1);
  }

  if (!config.llm.api_key) {
    printError("Error: DEEPSEEK_API_KEY not set. Set it in env or config.toml");
    process.exit(1);
  }

  const mcpManager = new MCPManager();
  if (Object.keys(config.mcp_servers).length > 0) {
    printInfo("Connecting MCP servers...");
    await mcpManager.connectAll(config.mcp_servers);
  }

  const agent = new Agent(config, mcpManager);
  if (resumeSessionId) {
    const saved = loadSession(resumeSessionId);
    if (!saved) {
      printCliError(`No saved session: ${resumeSessionId}`, json);
      process.exit(1);
    }
    agent.restoreMessages(saved.messages);
  }
  const stats = () => ({
    toolCount: getToolDefs().length + mcpManager.getToolDefs().length,
    mcpServerCount: mcpManager.getServerCount(),
    approvalMode: getApprovalMode(),
    sandboxMode: getSandboxMode(),
    writeMode: getWriteMode(),
  });
  const events = {
    onThinking: json ? undefined : printThinking,
    onToolStart: json ? undefined : printToolStart,
    onToolEnd: json ? undefined : printToolEnd,
  };
  const persistSnapshot = async (
    status: "closed" | "interrupted" | "error" | "manual" | "completed",
    note?: string,
    error?: string
  ): Promise<SessionMemoryResult> => {
    saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
    return saveSessionMemory({ sessionId, cwd: process.cwd(), runtime: agent.getRuntime(), messages: agent.getMessages(), status, note, error });
  };

  if (task) {
    try {
      const reply = await agent.run(task, events);
      await persistSnapshot("completed", "single task completed");
      if (json) {
        console.log(JSON.stringify({ ok: true, session: sessionId, ...agent.getRuntime(), output: reply }, null, 2));
      } else {
        printAssistant(reply);
      }
    } catch (err: any) {
      await persistSnapshot("error", "single task failed; resume this session and retry after the network recovers", err.message);
      if (json) console.error(JSON.stringify({ ok: false, session: sessionId, error: { message: err.message } }, null, 2));
      else printCliError(err.message, false);
      mcpManager.disconnectAll();
      process.exit(1);
    }
    mcpManager.disconnectAll();
    process.exit(0);
  }

  banner(agent.getRuntime(), process.cwd(), stats());
  printInfo(formatSessionInfo(sessionId));

  const commandContext: CommandContext = { agent, sessionId, stats, mcpManager, config, persistSnapshot };
  const rl = createRL((context) => buildSlashMenu(context.line, context.cursor));
  rl.prompt();
  let lineQueue = Promise.resolve();

  const processLine = async (line: string) => {
    const input = normalizeCommandInput(line.trim());
    if (!input) { rl.prompt(); return; }

    const handled = await handleCommand(input, commandContext);
    if (handled) {
      rl.prompt();
      return;
    }

    try {
      const reply = await agent.run(line, events);
      await persistSnapshot("completed", "assistant reply completed");
      printAssistant(reply);
    } catch (err: any) {
      printError(`Error: ${err.message}`);
      const result = await persistSnapshot("error", "assistant request failed; /retry can resend the last user message", err.message);
      printMemoryResult(result);
    }
    rl.prompt();
  };

  rl.on("line", (line) => {
    lineQueue = lineQueue.then(() => processLine(line)).catch((err: any) => printError(`Error: ${err.message}`));
  });

  rl.on("close", () => void lineQueue.finally(() => shutdown("closed")));

  process.on("SIGINT", () => {
    void shutdown("interrupted");
  });

  async function shutdown(status: "closed" | "interrupted") {
    try {
      await persistSnapshot(status, status === "interrupted" ? "SIGINT received" : "reader closed");
    } catch {}
    mcpManager.disconnectAll();
    process.exit(0);
  }
}

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(_enabled: boolean) {}
  resume() {}
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  buffer = "";
  write(chunk: string | Uint8Array): boolean {
    this.buffer += chunk.toString();
    return true;
  }
}

function runEditorSelfTest() {
  const promptInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const promptOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const promptReader = new TerminalLineReader(promptInput, promptOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  promptReader.prompt();
  for (const char of Array.from("hello /mo")) promptReader.debugKey(char, { name: char });
  const menu = promptReader.debugState().slashLabels;
  if (!menu.some((label) => label.startsWith("/model"))) throw new Error("slash palette did not expose /model");
  promptReader.debugKey(undefined, { name: "tab" });
  if (promptReader.debugState().line !== "hello /model ") throw new Error(`slash accept failed: ${promptReader.debugState().line}`);
  promptReader.close();

  const backslashInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const backslashOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const backslashReader = new TerminalLineReader(backslashInput, backslashOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  backslashReader.prompt();
  for (const char of Array.from("please \\per")) backslashReader.debugKey(char, { name: char });
  const backslashMenu = backslashReader.debugState().slashLabels;
  if (!backslashMenu.some((label) => label.includes("/permission-model"))) throw new Error("backslash palette did not expose /permission-model");
  backslashReader.close();

  const nestedInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const nestedOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const nestedReader = new TerminalLineReader(nestedInput, nestedOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  nestedReader.prompt();
  for (const char of Array.from("/permission-model ")) nestedReader.debugKey(char, { name: char });
  const nestedMenu = nestedReader.debugState().slashLabels;
  if (!nestedMenu.some((label) => label === "trusted")) throw new Error("permission-model arguments were not exposed");
  nestedReader.close();

  const mcpInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const mcpOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const mcpReader = new TerminalLineReader(mcpInput, mcpOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  mcpReader.prompt();
  for (const char of Array.from("/mcp ")) mcpReader.debugKey(char, { name: char });
  if (!mcpReader.debugState().slashLabels.includes("reconnect")) throw new Error("mcp reconnect option was not exposed");
  mcpReader.close();

  const memoryInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const memoryOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const memoryReader = new TerminalLineReader(memoryInput, memoryOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  memoryReader.prompt();
  for (const char of Array.from("/memory ")) memoryReader.debugKey(char, { name: char });
  if (!memoryReader.debugState().slashLabels.includes("save")) throw new Error("memory save option was not exposed");
  memoryReader.close();

  const selectionInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const selectionOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const selectionReader = new TerminalLineReader(selectionInput, selectionOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  selectionReader.prompt();
  for (const char of Array.from("abcdef")) selectionReader.debugKey(char, { name: char });
  selectionReader.debugKey(undefined, { name: "left", shift: true, sequence: "\x1b[D" });
  selectionReader.debugKey(undefined, { name: "left", shift: true, sequence: "\x1b[D" });
  selectionReader.debugKey(undefined, { name: "backspace" });
  if (selectionReader.debugState().line !== "abcd") throw new Error(`selection delete failed: ${selectionReader.debugState().line}`);
  selectionReader.close();

  const wrapInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const wrapOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  wrapOutput.columns = 16;
  const wrapReader = new TerminalLineReader(wrapInput, wrapOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  wrapReader.prompt();
  for (const char of Array.from("abcdefghijklmnopqrst")) wrapReader.debugKey(char, { name: char });
  const beforeUp = wrapReader.debugState().cursor;
  wrapReader.debugKey(undefined, { name: "up", sequence: "\x1b[A" });
  const afterUp = wrapReader.debugState().cursor;
  if (afterUp >= beforeUp) throw new Error("up arrow did not move the cursor to the previous visual row");
  wrapReader.debugKey(undefined, { name: "down", sequence: "\x1b[B" });
  if (wrapReader.debugState().cursor !== beforeUp) throw new Error("down arrow did not restore the cursor to the next visual row");
  wrapReader.close();

  const mouseInput = new FakeInput() as unknown as NodeJS.ReadStream;
  const mouseOutput = new FakeOutput() as unknown as NodeJS.WriteStream;
  const mouseReader = new TerminalLineReader(mouseInput, mouseOutput, ({ line, cursor }) => buildSlashMenu(line, cursor));
  mouseReader.prompt();
  for (const char of Array.from("abc")) mouseReader.debugKey(char, { name: char });
  mouseReader.debugKey("\x1b[<0;1;1M");
  if (mouseReader.debugState().line !== "abc") throw new Error(`mouse sequence leaked into input: ${mouseReader.debugState().line}`);
  mouseReader.close();

  if (normalizeCommandInput("\\permission-model trusted") !== "/permission-model trusted") {
    throw new Error("backslash normalization failed");
  }

  console.log(JSON.stringify({ ok: true, slash: true, backslash: true, nested: true, mcp_nested: true, memory_nested: true, selection_delete: true, vertical_cursor: true, mouse_swallow: true }));
}

interface CommandContext {
  agent: Agent;
  sessionId: string;
  stats: () => ReturnType<typeof currentStats>;
  mcpManager: MCPManager;
  config: Config;
  persistSnapshot: (
    status: "closed" | "interrupted" | "error" | "manual" | "completed",
    note?: string,
    error?: string
  ) => Promise<SessionMemoryResult>;
}

function currentStats() {
  return {
    toolCount: 0,
    mcpServerCount: 0,
    approvalMode: getApprovalMode(),
    sandboxMode: getSandboxMode(),
    writeMode: getWriteMode(),
  };
}

const COMMAND_DEFS = [
  { name: "help", args: "", description: "show commands and editor shortcuts", submit: true },
  { name: "status", args: "", description: "show model, cwd, tools, MCP, and safety state", submit: true },
  { name: "doctor", args: "", description: "run local config/auth/MCP diagnostics", submit: true },
  { name: "tools", args: "", description: "list built-in and MCP tools", submit: true },
  { name: "mcp", args: "<status|reconnect>", description: "inspect or reconnect MCP servers" },
  { name: "sessions", args: "[n]", description: "list recent saved sessions" },
  { name: "memory", args: "<save|status>", description: "save current session summary to agentmemory" },
  { name: "retry", args: "", description: "retry the last user request after a network failure", submit: true },
  { name: "permissions", args: "", description: "show permission model, approval, sandbox, and write-mode controls", submit: true },
  { name: "permission-model", args: "<mode>", description: "choose safe, read-only, trusted, or locked safety bundles" },
  { name: "approval", args: "<mode>", description: "set shell approvals: on-request, auto, never" },
  { name: "sandbox", args: "<mode>", description: "set file-write sandbox: workspace-write, read-only, unrestricted" },
  { name: "write-mode", args: "<mode>", description: "set file writes: preview or direct" },
  { name: "models", args: "", description: "list model presets and aliases", submit: true },
  { name: "model", args: "<name>", description: "switch model preset or full model name" },
  { name: "thinking", args: "<mode>", description: "switch thinking: auto, on, off, high, max" },
  { name: "session", args: "", description: "save and show current session path", submit: true },
  { name: "compact", args: "[n]", description: "summarize older context, keeping n recent messages" },
  { name: "approvals", args: "", description: "list pending shell approvals", submit: true },
  { name: "approve", args: "<id>", description: "run a pending shell command" },
  { name: "deny", args: "<id>", description: "reject a pending shell command" },
  { name: "patches", args: "", description: "list pending file patch previews", submit: true },
  { name: "apply", args: "<id>", description: "apply a pending file patch" },
  { name: "reject", args: "<id>", description: "reject a pending file patch" },
  { name: "clear", args: "", description: "clear the terminal", submit: true },
  { name: "exit", args: "", description: "quit DeepSeek CLI", submit: true },
  { name: "quit", args: "", description: "quit DeepSeek CLI", submit: true },
] as const;

const PERMISSION_MODE_OPTIONS = [
  { value: "safe", description: "preview writes, workspace sandbox, ask before risky shell" },
  { value: "read-only", description: "block file writes, keep shell approvals on-request" },
  { value: "trusted", description: "direct writes, unrestricted sandbox, auto-run risky shell" },
  { value: "locked", description: "preview writes, read-only sandbox, never run risky shell" },
] as const;

const APPROVAL_OPTIONS = [
  { value: "on-request", description: "queue risky shell commands for /approve" },
  { value: "auto", description: "auto-run risky shell commands except blocked patterns" },
  { value: "never", description: "never run risky shell commands" },
] as const;

const SANDBOX_OPTIONS = [
  { value: "workspace-write", description: "allow writes only inside the current workspace" },
  { value: "read-only", description: "block all file writes" },
  { value: "unrestricted", description: "allow writes anywhere this process can write" },
] as const;

const WRITE_MODE_OPTIONS = [
  { value: "preview", description: "create patch previews for /apply" },
  { value: "direct", description: "write files immediately through tools" },
] as const;

const THINKING_OPTIONS = [
  { value: "auto", description: "let DeepSeek default decide" },
  { value: "on", description: "enable thinking with high effort" },
  { value: "off", description: "disable thinking" },
  { value: "high", description: "enable thinking with high effort" },
  { value: "max", description: "enable thinking with max effort" },
] as const;

function normalizeCommandInput(input: string): string {
  if (input.startsWith("\\")) return `/${input.slice(1)}`;
  if (input.startsWith("/")) return input;
  const embedded = input.match(/(?:^|\s)([\\/])([A-Za-z][\w-]*)(?:\s+([^\s]+))?/);
  if (!embedded) return input;
  const command = embedded[2].toLowerCase();
  if (!isKnownCommand(command)) return input;
  const arg = embedded[3] ?? "";
  return `/${command}${arg ? ` ${arg}` : ""}`;
}

function isKnownCommand(command: string): boolean {
  return COMMAND_DEFS.some((item) => item.name === command) || [
    "quit",
    "permissions-model",
    "approval-mode",
    "sandbox-mode",
    "writemode",
  ].includes(command);
}

async function handleCommand(input: string, context: CommandContext): Promise<boolean> {
  const [commandName, ...args] = input.slice(1).split(/\s+/);
  if (!input.startsWith("/") || !commandName) return false;
  const command = commandName.toLowerCase();
  const arg = args.join(" ").trim();

  try {
    switch (command) {
      case "exit":
      case "quit":
        context.mcpManager.disconnectAll();
        process.exit(0);
        return true;
      case "help":
        printHelp();
        return true;
      case "models":
        printModels(false);
        return true;
      case "doctor":
        printDoctor(context.config, false, context.mcpManager);
        return true;
      case "tools":
        printTools(context.mcpManager);
        return true;
      case "mcp":
        await handleMcpCommand(arg, context);
        return true;
      case "sessions":
        printSessions(arg ? Number(arg) : 10);
        return true;
      case "memory":
        await handleMemoryCommand(arg, context);
        return true;
      case "retry": {
        const reply = await context.agent.retryLast({ onThinking: printThinking, onToolStart: printToolStart, onToolEnd: printToolEnd });
        await context.persistSnapshot("completed", "retry completed");
        printAssistant(reply);
        return true;
      }
      case "status":
        printStatus(context.agent.getRuntime(), process.cwd(), context.stats());
        return true;
      case "permissions":
        printPermissions();
        return true;
      case "permission-model":
      case "permissions-model":
        if (!arg) printError("Usage: /permission-model <safe|read-only|trusted|locked>");
        else console.log(applyPermissionModel(arg));
        return true;
      case "approval":
      case "approval-mode":
        if (!arg) printError("Usage: /approval <on-request|auto|never>");
        else console.log(`approval_mode: ${setApprovalMode(arg)}`);
        return true;
      case "sandbox":
      case "sandbox-mode":
        if (!arg) printError("Usage: /sandbox <workspace-write|read-only|unrestricted>");
        else console.log(`sandbox_mode: ${setSandboxMode(arg)}`);
        return true;
      case "write-mode":
      case "writemode":
        if (!arg) printError("Usage: /write-mode <preview|direct>");
        else console.log(`write_mode: ${setWriteMode(arg)}`);
        return true;
      case "session":
        saveSession(context.sessionId, process.cwd(), context.agent.getRuntime(), context.agent.getMessages());
        console.log(formatSessionInfo(context.sessionId));
        return true;
      case "compact": {
        const keep = arg ? Number(arg) : 12;
        const message = context.agent.compactContext(Number.isFinite(keep) ? keep : 12);
        saveSession(context.sessionId, process.cwd(), context.agent.getRuntime(), context.agent.getMessages());
        console.log(message);
        return true;
      }
      case "approvals": {
        const approvals = listShellApprovals();
        console.log(approvals.length ? approvals.map((item) => `${item.id} ${item.reason}\n${item.command}`).join("\n\n") : "No pending shell approvals.");
        return true;
      }
      case "approve": {
        if (!arg) printError("Usage: /approve <id>");
        else {
          const approval = takeShellApproval(arg);
          if (!approval) printError(`No pending shell approval: ${arg}`);
          else {
            printInfo(`Running approved shell command ${arg}...`);
            const result = await runShellCommand(approval.command, approval.timeout);
            console.log(result.output);
          }
        }
        return true;
      }
      case "deny":
        if (!arg) printError("Usage: /deny <id>");
        else console.log(rejectShellApproval(arg) ? `Rejected shell approval ${arg}` : `No pending shell approval: ${arg}`);
        return true;
      case "patches":
        console.log(formatPatchList());
        return true;
      case "apply": {
        if (!arg) printError("Usage: /apply <patch-id>");
        else {
          const result = applyFilePatch(arg);
          console.log(result.message);
        }
        return true;
      }
      case "reject":
        if (!arg) printError("Usage: /reject <patch-id>");
        else console.log(rejectFilePatch(arg) ? `Rejected patch ${arg}` : `No pending patch: ${arg}`);
        return true;
      case "model":
        if (!arg) printError("Usage: /model <pro|flash|chat|reasoner|model-name>");
        else {
          context.agent.setModel(arg);
          printRuntimeUpdated(context.agent.getRuntime());
        }
        return true;
      case "thinking":
        if (!arg) printError("Usage: /thinking <auto|on|off|high|max>");
        else {
          const [thinking, effort] = arg.split(/\s+/, 2);
          context.agent.setThinking(thinking, effort);
          printRuntimeUpdated(context.agent.getRuntime());
        }
        return true;
      case "clear":
        console.clear();
        banner(context.agent.getRuntime(), process.cwd(), context.stats());
        return true;
      default:
        return false;
    }
  } catch (err: any) {
    printError(`Error: ${err.message}`);
    return true;
  }
}

function printPermissions() {
  console.log(`\nPermission controls\n  permission_model: ${describeCurrentPermissionModel()}\n  approval_mode:    ${getApprovalMode()}\n  sandbox_mode:     ${getSandboxMode()}\n  write_mode:       ${getWriteMode()}\n\nPermission models\n  safe       preview writes, workspace sandbox, approvals on-request\n  read-only  block file writes, approvals on-request\n  trusted    direct writes, unrestricted sandbox, approvals auto\n  locked     preview writes, read-only sandbox, approvals never\n`);
}

function describeCurrentPermissionModel(): string {
  const approval = getApprovalMode();
  const sandbox = getSandboxMode();
  const write = getWriteMode();
  if (approval === "on-request" && sandbox === "workspace-write" && write === "preview") return "safe";
  if (approval === "on-request" && sandbox === "read-only" && write === "preview") return "read-only";
  if (approval === "auto" && sandbox === "unrestricted" && write === "direct") return "trusted";
  if (approval === "never" && sandbox === "read-only" && write === "preview") return "locked";
  return "custom";
}

function applyPermissionModel(mode: string): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "safe" || normalized === "default") {
    setWriteMode("preview");
    setSandboxMode("workspace-write");
    setApprovalMode("on-request");
  } else if (normalized === "read-only" || normalized === "readonly") {
    setWriteMode("preview");
    setSandboxMode("read-only");
    setApprovalMode("on-request");
  } else if (normalized === "trusted" || normalized === "full-access") {
    setWriteMode("direct");
    setSandboxMode("unrestricted");
    setApprovalMode("auto");
  } else if (normalized === "locked") {
    setWriteMode("preview");
    setSandboxMode("read-only");
    setApprovalMode("never");
  } else {
    throw new Error("Permission model must be safe, read-only, trusted, or locked");
  }
  return `permission_model: ${describeCurrentPermissionModel()} (approval=${getApprovalMode()}, sandbox=${getSandboxMode()}, write=${getWriteMode()})`;
}

async function handleMcpCommand(arg: string, context: CommandContext): Promise<void> {
  const subcommand = arg.trim().toLowerCase() || "status";
  if (subcommand === "status" || subcommand === "list") {
    printMcpDiagnostics(context.mcpManager);
    return;
  }
  if (subcommand === "reconnect" || subcommand === "reload") {
    context.mcpManager.disconnectAll();
    await context.mcpManager.connectAll(context.config.mcp_servers);
    printMcpDiagnostics(context.mcpManager);
    return;
  }
  printError("Usage: /mcp <status|reconnect>");
}

async function handleMemoryCommand(arg: string, context: CommandContext): Promise<void> {
  const subcommand = arg.trim().toLowerCase() || "save";
  if (subcommand === "save" || subcommand === "snapshot") {
    const result = await context.persistSnapshot("manual", "manual /memory save");
    printMemoryResult(result);
    return;
  }
  if (subcommand === "status") {
    const result = await context.persistSnapshot("manual", "manual /memory status probe");
    printMemoryResult(result);
    return;
  }
  printError("Usage: /memory <save|status>");
}

function printTools(mcpManager: MCPManager) {
  const builtin = getToolDefs().map((tool) => tool.function.name);
  const mcp = mcpManager.getToolDefs().map((tool) => tool.function.name);
  console.log(`\nTools\n  built-in (${builtin.length})\n${builtin.map((name) => `    ${name}`).join("\n") || "    none"}\n\n  MCP (${mcp.length})\n${mcp.map((name) => `    ${name}`).join("\n") || "    none"}\n`);
}

function printMcpDiagnostics(mcpManager: MCPManager) {
  const diagnostics = mcpManager.getDiagnostics();
  if (diagnostics.length === 0) {
    console.log("No MCP servers configured or connected.");
    return;
  }
  console.log(diagnostics.map((item) => `${item.ok ? "ok" : "fail"} ${item.name} tools=${item.tools}${item.error ? ` error=${item.error}` : ""}`).join("\n"));
}

function printSessions(limit: number) {
  const sessions = listSessions(Number.isFinite(limit) ? limit : 10);
  if (sessions.length === 0) {
    console.log("No saved sessions.");
    return;
  }
  console.log(sessions.map((session) => `${session.id} updated=${session.updated_at} messages=${session.messages.length} cwd=${session.cwd}`).join("\n"));
}

function printMemoryResult(result: SessionMemoryResult) {
  if (result.skipped) {
    console.log("agentmemory autosave skipped by environment setting");
  } else if (result.agentmemory) {
    console.log("saved session summary to agentmemory");
  } else if (result.fallbackPath) {
    console.log(`saved session summary fallback: ${result.fallbackPath}`);
  } else if (result.error) {
    console.log(`memory save failed: ${result.error}`);
  }
}

function buildSlashMenu(line: string, cursor: number): SlashMenuResult | null {
  const token = findSlashToken(line, cursor);
  if (!token) return null;
  const raw = line.slice(token.start, token.end);
  const commandText = raw[0] === "\\" ? `/${raw.slice(1)}` : raw;
  const parts = commandText.slice(1).split(/\s+/);
  const commandQuery = parts[0]?.toLowerCase() ?? "";
  const argumentQuery = parts.length > 1 ? parts.slice(1).join(" ").toLowerCase() : "";
  const hasArgumentPosition = /\s/.test(commandText);

  if (hasArgumentPosition) {
    const nested = buildArgumentMenu(commandQuery, argumentQuery, token.start, token.end);
    if (nested) return nested;
  }

  const items = COMMAND_DEFS
    .filter((command) => fuzzyMatch(command.name, commandQuery))
    .sort((left, right) => commandMatchScore(left.name, commandQuery) - commandMatchScore(right.name, commandQuery))
    .map((command) => {
      const replacement = `/${command.name}${command.args ? " " : ""}`;
      return {
        label: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
        description: command.description,
        replacement,
        submitOnAccept: "submit" in command ? command.submit : false,
      } satisfies SlashMenuItem;
    });

  return {
    title: "Commands",
    replaceStart: token.start,
    replaceEnd: token.end,
    items,
  };
}

function buildArgumentMenu(command: string, query: string, replaceStart: number, replaceEnd: number): SlashMenuResult | null {
  const optionGroups: Record<string, readonly { value: string; description: string }[]> = {
    "permission-model": PERMISSION_MODE_OPTIONS,
    "permissions-model": PERMISSION_MODE_OPTIONS,
    approval: APPROVAL_OPTIONS,
    "approval-mode": APPROVAL_OPTIONS,
    sandbox: SANDBOX_OPTIONS,
    "sandbox-mode": SANDBOX_OPTIONS,
    "write-mode": WRITE_MODE_OPTIONS,
    writemode: WRITE_MODE_OPTIONS,
    thinking: THINKING_OPTIONS,
    mcp: [
      { value: "status", description: "show MCP connection diagnostics" },
      { value: "reconnect", description: "disconnect and reconnect configured MCP servers" },
    ],
    memory: [
      { value: "save", description: "save a compact session summary to agentmemory" },
      { value: "status", description: "probe agentmemory save path and report fallback" },
    ],
    model: [
      ...MODEL_PRESETS.map((preset) => ({ value: preset.name, description: `${preset.model}, thinking=${preset.thinking}` })),
      { value: "chat", description: "compatibility alias, non-thinking Flash" },
      { value: "reasoner", description: "compatibility alias, thinking Flash" },
    ],
    approve: listShellApprovals().map((approval) => ({ value: approval.id, description: approval.reason })),
    deny: listShellApprovals().map((approval) => ({ value: approval.id, description: approval.reason })),
  };
  const options = optionGroups[command];
  if (!options) return null;
  const prefix = `/${command} `;
  const filtered = options.filter((option) => fuzzyMatch(option.value, query));
  return {
    title: `${prefix.trim()} choices`,
    replaceStart,
    replaceEnd,
    items: filtered.map((option) => ({
      label: option.value,
      description: option.description,
      replacement: `${prefix}${option.value}`,
      submitOnAccept: true,
    })),
  };
}

function findSlashToken(line: string, cursor: number): { start: number; end: number } | null {
  for (let start = Math.min(cursor, line.length) - 1; start >= 0; start--) {
    const char = line[start];
    if (char !== "/" && char !== "\\") continue;
    const before = start === 0 ? "" : line[start - 1];
    const after = line[start + 1] ?? "";
    if (before && !isWhitespace(before)) continue;
    if (after && !isWhitespace(after) && !/[A-Za-z0-9_-]/.test(after)) continue;
    const prefix = line.slice(start, cursor);
    const commandMatch = prefix.match(/^[\\/]([A-Za-z][\w-]*)?(?:\s+[^\s]*)?$/);
    if (!commandMatch) continue;
    let end = cursor;
    while (end < line.length && !isWhitespace(line[end])) end += 1;
    return { start, end };
  }
  return null;
}

function commandMatchScore(value: string, query: string): number {
  if (!query) return 0;
  const normalized = value.toLowerCase();
  if (normalized === query) return -100;
  if (normalized.startsWith(query)) return normalized.length;
  const index = normalized.indexOf(query);
  if (index !== -1) return 100 + index + normalized.length;
  return 1000 + normalized.length;
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true;
  const normalized = value.toLowerCase();
  if (normalized.includes(query)) return true;
  let index = 0;
  for (const char of query) {
    index = normalized.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function isWhitespace(char: string | undefined): boolean {
  return !char || /\s/.test(char);
}

function printDoctor(config: Config, json = false, mcpManager?: MCPManager) {
  const configuredMcpServers = Object.keys(config.mcp_servers).length;
  const hasApiKey = Boolean(config.llm.api_key);
  const payload = {
    ok: hasApiKey,
    version: VERSION,
    model: config.llm.model,
    thinking: config.llm.thinking,
    reasoning_effort: config.llm.reasoning_effort,
    base_url: config.llm.base_url,
    config_path: config.config_path ?? null,
    auth: {
      api_key: hasApiKey ? "configured" : "missing",
      source: process.env.DEEPSEEK_API_KEY ? "env" : config.llm.api_key ? "config" : "missing",
    },
    cwd: process.cwd(),
    safety: {
      approval_mode: getApprovalMode(),
      write_mode: getWriteMode(),
      sandbox_mode: getSandboxMode(),
    },
    mcp_servers: configuredMcpServers,
    mcp_configured: Object.keys(config.mcp_servers),
    mcp_diagnostics: mcpManager?.getDiagnostics() ?? [],
    builtin_tools: getToolDefs().map((tool) => tool.function.name),
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function printModels(json = false) {
  const payload = {
    models: MODEL_PRESETS,
    aliases: {
      chat: "deepseek-v4-flash + thinking disabled",
      reasoner: "deepseek-v4-flash + thinking enabled",
      "deepseek-chat": "deepseek-v4-flash + thinking disabled",
      "deepseek-reasoner": "deepseek-v4-flash + thinking enabled",
    },
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("Available DeepSeek model presets:\n");
  for (const preset of MODEL_PRESETS) {
    console.log(`  ${preset.name.padEnd(20)} ${preset.model.padEnd(22)} thinking=${preset.thinking}`);
    console.log(`  ${"".padEnd(20)} ${preset.description}`);
  }
  console.log("\nAliases: chat, reasoner, deepseek-chat, deepseek-reasoner");
}

function parseRuntimeArgs(args: string[]) {
  return {
    model: readFlag(args, "--model") ?? readFlag(args, "-m"),
    thinking: readFlag(args, "--thinking"),
    reasoning_effort: readFlag(args, "--reasoning-effort"),
  };
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    const prefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (!inline) return undefined;
    const value = inline.slice(prefix.length);
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPositionalTask(args: string[]): string | null {
  const valueFlags = new Set(["-t", "--task", "-m", "--model", "--thinking", "--reasoning-effort", "--cwd", "--workspace", "--session", "--resume"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--") || arg.startsWith("-")) continue;
    return args.slice(i).join(" ");
  }
  return null;
}

function printCliError(message: string, json = false) {
  if (json) {
    console.error(JSON.stringify({ ok: false, error: { message } }, null, 2));
    return;
  }
  printError(`Error: ${message}`);
}

function changeDirectory(path: string) {
  try {
    process.chdir(path);
  } catch (err: any) {
    throw new Error(`Cannot use cwd ${path}: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
