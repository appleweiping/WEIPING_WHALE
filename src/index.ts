#!/usr/bin/env node
import { MODEL_PRESETS, applyRuntimeOverrides, loadConfig, type Config } from "./config.js";
import { Agent } from "./agent.js";
import { MCPManager } from "./mcp/manager.js";
import { getToolDefs } from "./tools/registry.js";
import { formatPatchList, applyFilePatch, rejectFilePatch } from "./safety/patches.js";
import { getApprovalMode, listShellApprovals, rejectShellApproval, takeShellApproval } from "./safety/approval.js";
import { getWriteMode } from "./safety/patches.js";
import { getSandboxMode } from "./safety/sandbox.js";
import { runShellCommand } from "./tools/bash.js";
import { createSessionId, formatSessionInfo, loadSession, saveSession } from "./session.js";
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
  });
  const events = {
    onThinking: json ? undefined : printThinking,
    onToolStart: json ? undefined : printToolStart,
    onToolEnd: json ? undefined : printToolEnd,
  };

  if (task) {
    const reply = await agent.run(task, events);
    saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
    if (json) {
      console.log(JSON.stringify({ ok: true, session: sessionId, ...agent.getRuntime(), output: reply }, null, 2));
    } else {
      printAssistant(reply);
    }
    mcpManager.disconnectAll();
    process.exit(0);
  }

  banner(agent.getRuntime(), process.cwd(), stats());
  printInfo(formatSessionInfo(sessionId));

  const rl = createRL();
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "/exit" || input === "/quit") {
      mcpManager.disconnectAll();
      process.exit(0);
    }
    if (input === "/help") {
      printHelp();
      rl.prompt();
      return;
    }
    if (input === "/models") {
      printModels(false);
      rl.prompt();
      return;
    }
    if (input === "/status") {
      printStatus(agent.getRuntime(), process.cwd(), stats());
      rl.prompt();
      return;
    }
    if (input === "/session") {
      saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
      console.log(formatSessionInfo(sessionId));
      rl.prompt();
      return;
    }
    if (input.startsWith("/compact")) {
      const [, keep] = input.split(/\s+/, 2);
      const message = agent.compactContext(keep ? Number(keep) : 12);
      saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
      console.log(message);
      rl.prompt();
      return;
    }
    if (input === "/approvals") {
      const approvals = listShellApprovals();
      console.log(approvals.length ? approvals.map((item) => `${item.id} ${item.reason}\n${item.command}`).join("\n\n") : "No pending shell approvals.");
      rl.prompt();
      return;
    }
    if (input.startsWith("/approve")) {
      const [, id] = input.split(/\s+/, 2);
      if (!id) printError("Usage: /approve <id>");
      else {
        const approval = takeShellApproval(id);
        if (!approval) printError(`No pending shell approval: ${id}`);
        else {
          printInfo(`Running approved shell command ${id}...`);
          const result = await runShellCommand(approval.command, approval.timeout);
          console.log(result.output);
        }
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/deny")) {
      const [, id] = input.split(/\s+/, 2);
      if (!id) printError("Usage: /deny <id>");
      else console.log(rejectShellApproval(id) ? `Rejected shell approval ${id}` : `No pending shell approval: ${id}`);
      rl.prompt();
      return;
    }
    if (input === "/patches") {
      console.log(formatPatchList());
      rl.prompt();
      return;
    }
    if (input.startsWith("/apply")) {
      const [, id] = input.split(/\s+/, 2);
      if (!id) printError("Usage: /apply <patch-id>");
      else {
        const result = applyFilePatch(id);
        console.log(result.message);
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/reject")) {
      const [, id] = input.split(/\s+/, 2);
      if (!id) printError("Usage: /reject <patch-id>");
      else console.log(rejectFilePatch(id) ? `Rejected patch ${id}` : `No pending patch: ${id}`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/model")) {
      const [, model] = input.split(/\s+/, 2);
      if (!model) {
        printError("Usage: /model <pro|flash|chat|reasoner|model-name>");
      } else {
        agent.setModel(model);
        printRuntimeUpdated(agent.getRuntime());
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/thinking")) {
      const [, thinking, effort] = input.split(/\s+/, 3);
      if (!thinking) {
        printError("Usage: /thinking <auto|on|off|high|max>");
      } else {
        try {
          agent.setThinking(thinking, effort);
          printRuntimeUpdated(agent.getRuntime());
        } catch (err: any) {
          printError(`Error: ${err.message}`);
        }
      }
      rl.prompt();
      return;
    }
    if (input === "/clear") {
      console.clear();
      banner(agent.getRuntime(), process.cwd(), stats());
      rl.prompt();
      return;
    }

    try {
      const reply = await agent.run(input, events);
      saveSession(sessionId, process.cwd(), agent.getRuntime(), agent.getMessages());
      printAssistant(reply);
    } catch (err: any) {
      printError(`Error: ${err.message}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    mcpManager.disconnectAll();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    mcpManager.disconnectAll();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
