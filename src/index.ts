#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { MCPManager } from "./mcp/manager.js";
import { getToolDefs } from "./tools/registry.js";
import {
  banner,
  createRL,
  printAssistant,
  printError,
  printHelp,
  printInfo,
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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const taskIdx = args.indexOf("-t");
  const task = taskIdx !== -1 ? args[taskIdx + 1] : null;

  const config = loadConfig();

  if (args.includes("--doctor")) {
    printDoctor(config);
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
  const stats = () => ({
    toolCount: getToolDefs().length + mcpManager.getToolDefs().length,
    mcpServerCount: mcpManager.getServerCount(),
  });
  const events = {
    onThinking: printThinking,
    onToolStart: printToolStart,
    onToolEnd: printToolEnd,
  };

  if (task) {
    const reply = await agent.run(task, events);
    printAssistant(reply);
    mcpManager.disconnectAll();
    process.exit(0);
  }

  banner(config.llm.model, process.cwd(), stats());

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
    if (input === "/status") {
      printStatus(config.llm.model, process.cwd(), stats());
      rl.prompt();
      return;
    }
    if (input === "/clear") {
      console.clear();
      banner(config.llm.model, process.cwd(), stats());
      rl.prompt();
      return;
    }

    try {
      const reply = await agent.run(input, events);
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

function printDoctor(config: ReturnType<typeof loadConfig>) {
  const configuredMcpServers = Object.keys(config.mcp_servers).length;
  const hasApiKey = Boolean(config.llm.api_key);
  const payload = {
    ok: hasApiKey,
    model: config.llm.model,
    base_url: config.llm.base_url,
    api_key: hasApiKey ? "configured" : "missing",
    cwd: process.cwd(),
    mcp_servers: configuredMcpServers,
    builtin_tools: getToolDefs().map((tool) => tool.function.name),
  };
  console.log(JSON.stringify(payload, null, 2));
}
