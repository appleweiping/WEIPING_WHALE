import { writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.env.MCP_ENV_REPORT) {
  writeFileSync(
    process.env.MCP_ENV_REPORT,
    JSON.stringify({
      saw_deepseek_api_key: Boolean(process.env.DEEPSEEK_API_KEY),
      saw_agentmemory_secret: Boolean(process.env.AGENTMEMORY_SECRET),
      saw_explicit_allowed: process.env.EXPLICIT_ALLOWED === "yes",
    }),
    "utf-8",
  );
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "env_probe",
          description: "Probe MCP env inheritance for tests",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            saw_deepseek_api_key: Boolean(process.env.DEEPSEEK_API_KEY),
            saw_agentmemory_secret: Boolean(process.env.AGENTMEMORY_SECRET),
            saw_explicit_allowed: process.env.EXPLICIT_ALLOWED === "yes",
          }),
        },
      ],
    });
    return;
  }
  respond(message.id, null);
});

function respond(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

