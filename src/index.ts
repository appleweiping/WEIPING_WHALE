#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { MCPManager } from "./mcp/manager.js";
import { banner, createRL, printAssistant, printInfo } from "./ui/terminal.js";

// Register built-in tools
import "./tools/bash.js";
import "./tools/file-read.js";
import "./tools/file-write.js";
import "./tools/glob.js";

async function main() {
  const args = process.argv.slice(2);
  const taskIdx = args.indexOf("-t");
  const task = taskIdx !== -1 ? args[taskIdx + 1] : null;

  const config = loadConfig();

  if (!config.llm.api_key) {
    console.error("Error: DEEPSEEK_API_KEY not set. Set it in env or config.toml");
    process.exit(1);
  }

  const mcpManager = new MCPManager();
  if (Object.keys(config.mcp_servers).length > 0) {
    printInfo("Connecting MCP servers...");
    await mcpManager.connectAll(config.mcp_servers);
  }

  const agent = new Agent(config, mcpManager);

  if (task) {
    const reply = await agent.run(task);
    printAssistant(reply);
    mcpManager.disconnectAll();
    process.exit(0);
  }

  banner(config.llm.model, process.cwd());

  const rl = createRL();
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "/exit" || input === "/quit") {
      mcpManager.disconnectAll();
      process.exit(0);
    }

    try {
      const reply = await agent.run(input);
      printAssistant(reply);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
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
