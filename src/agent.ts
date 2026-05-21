import { DeepSeekClient, type Message, type ToolDef, type ToolCall } from "./llm/deepseek.js";
import { getToolDefs, getTool } from "./tools/registry.js";
import { MCPManager } from "./mcp/manager.js";
import type { Config } from "./config.js";

const SYSTEM_PROMPT = `You are DeepSeek CLI, an interactive coding agent running in the user's terminal.
You can read/write files, execute commands, and search code to help the user with software engineering tasks.
Be direct and concise. Use tools to gather information before answering when needed.
When you have MCP tools available (prefixed with mcp_), use them as appropriate.`;

export class Agent {
  private client: DeepSeekClient;
  private mcpManager: MCPManager;
  private messages: Message[] = [];
  private maxIterations: number;

  constructor(config: Config, mcpManager: MCPManager) {
    this.client = new DeepSeekClient(config.llm);
    this.mcpManager = mcpManager;
    this.maxIterations = config.agent.max_iterations;

    const systemPrompt = config.agent.system_prompt || SYSTEM_PROMPT;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  async run(userMessage: string, events: AgentEvents = {}): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    const allTools = [...getToolDefs(), ...this.mcpManager.getToolDefs()];

    for (let i = 0; i < this.maxIterations; i++) {
      events.onThinking?.(i + 1);
      const result = await this.client.complete({
        messages: this.messages,
        tools: allTools.length > 0 ? allTools : undefined,
      });

      if (result.tool_calls.length === 0) {
        const reply = result.content || "";
        this.messages.push({ role: "assistant", content: reply });
        return reply;
      }

      this.messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.tool_calls,
      });

      for (const tc of result.tool_calls) {
        const toolResult = await this.executeTool(tc, events);
        this.messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: tc.id,
        });
      }
    }

    return "[max iterations reached]";
  }

  private async executeTool(tc: ToolCall, events: AgentEvents): Promise<string> {
    const name = tc.function.name;
    let args: Record<string, any>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return "Error: invalid JSON arguments";
    }

    const startedAt = Date.now();
    events.onToolStart?.(name, args);

    const mcpResult = await this.mcpManager.callTool(name, args);
    if (mcpResult) {
      events.onToolEnd?.(name, Date.now() - startedAt, Boolean(mcpResult.error));
      return mcpResult.output;
    }

    const tool = getTool(name);
    if (!tool) {
      events.onToolEnd?.(name, Date.now() - startedAt, true);
      return `Unknown tool: ${name}`;
    }

    const result = await tool.handler(args);
    events.onToolEnd?.(name, Date.now() - startedAt, Boolean(result.error));
    return result.output;
  }
}

export interface AgentEvents {
  onThinking?: (iteration: number) => void;
  onToolStart?: (name: string, args: Record<string, any>) => void;
  onToolEnd?: (name: string, elapsedMs: number, error: boolean) => void;
}
