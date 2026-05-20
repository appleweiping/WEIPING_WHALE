import { spawn, ChildProcess } from "child_process";
import type { ToolDef } from "../llm/deepseek.js";
import type { ToolResult } from "../tools/registry.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export class MCPClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;
  private tools: MCPTool[] = [];
  public serverName: string;

  constructor(public command: string, public args: string[], public env: Record<string, string>, name: string) {
    this.serverName = name;
  }

  async connect(timeoutMs = 30000): Promise<void> {
    const mergedEnv = { ...process.env, ...this.env };
    this.proc = spawn(this.command, this.args, { env: mergedEnv, stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout!.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this.tryRead();
    });

    this.proc.stderr!.on("data", () => {});

    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    this.proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("MCP process exited"));
      this.pending.clear();
    });

    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "deepseek-cli", version: "0.1.0" },
    }, timeoutMs);

    await this.notify("notifications/initialized", {});

    const listResult = await this.request("tools/list", {}, timeoutMs);
    this.tools = listResult.tools || [];
  }

  getToolDefs(): ToolDef[] {
    return this.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: `mcp_${this.serverName}_${t.name}`,
        description: `[MCP:${this.serverName}] ${t.description}`,
        parameters: t.inputSchema,
      },
    }));
  }

  async callTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await this.request("tools/call", { name: toolName, arguments: args }, 60000);
      const text = result.content?.map((c: any) => c.text || JSON.stringify(c)).join("\n") || "";
      return { output: text };
    } catch (err: any) {
      return { output: `MCP error: ${err.message}`, error: true };
    }
  }

  disconnect() {
    this.proc?.kill();
    this.proc = null;
  }

  private send(message: any) {
    const json = JSON.stringify(message);
    this.proc!.stdin!.write(json + "\n");
  }

  private request(method: string, params: any, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  private notify(method: string, params: any) {
    this.send({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }

  private tryRead() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {}
    }
  }
}
