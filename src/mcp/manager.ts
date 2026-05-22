import { MCPClient } from "./client.js";
import type { MCPServerConfig } from "../config.js";
import type { ToolDef } from "../llm/deepseek.js";
import type { ToolResult } from "../tools/registry.js";

export class MCPManager {
  private clients: MCPClient[] = [];
  private connectionStatus: Array<{ name: string; ok: boolean; tools: number; error?: string }> = [];

  async connectAll(servers: Record<string, MCPServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      const client = new MCPClient(cfg.command, cfg.args || [], cfg.env || {}, name);
      try {
        await client.connect();
        this.clients.push(client);
        this.connectionStatus.push({ name, ok: true, tools: client.getToolDefs().length });
        process.stderr.write(`[mcp] Connected: ${name} (${client.getToolDefs().length} tools)\n`);
      } catch (err: any) {
        this.connectionStatus.push({ name, ok: false, tools: 0, error: err.message });
        process.stderr.write(`[mcp] Failed to connect ${name}: ${err.message}\n`);
      }
    }
  }

  getToolDefs(): ToolDef[] {
    return this.clients.flatMap((c) => c.getToolDefs());
  }

  getServerCount(): number {
    return this.clients.length;
  }

  getDiagnostics() {
    return this.connectionStatus;
  }

  async callTool(fullName: string, args: Record<string, any>): Promise<ToolResult | null> {
    for (const client of this.clients) {
      const prefix = `mcp_${client.serverName}_`;
      if (fullName.startsWith(prefix)) {
        const realName = fullName.slice(prefix.length);
        return client.callTool(realName, args);
      }
    }
    return null;
  }

  disconnectAll() {
    for (const c of this.clients) c.disconnect();
    this.clients = [];
  }
}
