import { DeepSeekClient, type Message, type ToolDef, type ToolCall, type Usage } from "./llm/deepseek.js";
import { getToolDefs, getTool, registerTool } from "./tools/registry.js";
import { MCPManager } from "./mcp/manager.js";
import {
  applyModelOverride,
  applyThinkingOverride,
  normalizeReasoningEffort,
  type Config,
} from "./config.js";
import { safeErrorMessage } from "./runtime/safe-text.js";

const SYSTEM_PROMPT = `You are DeepSeek CLI, an interactive coding agent running in the user's terminal.
You can read/write files, execute commands, and search code to help the user with software engineering tasks.
Be direct and concise. Use tools to gather information before answering when needed.
When you have MCP tools available (prefixed with mcp_), use them as appropriate.`;

export class Agent {
  private client: DeepSeekClient;
  private mcpManager: MCPManager;
  private config: Config;
  private messages: Message[] = [];
  private maxIterations: number;

  constructor(config: Config, mcpManager: MCPManager) {
    this.config = config;
    this.client = new DeepSeekClient(config.llm);
    this.mcpManager = mcpManager;
    this.maxIterations = config.agent.max_iterations;

    this.registerRuntimeTool();

    const systemPrompt = `${config.agent.system_prompt || SYSTEM_PROMPT}\n\n${RUNTIME_SWITCHING_PROMPT}`;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  setModel(model: string): string {
    applyModelOverride(this.config, model);
    const resolvedModel = this.config.llm.model;
    this.client.setModel(resolvedModel);
    this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
    return resolvedModel;
  }

  setThinking(thinking: string, reasoningEffort?: string): { mode: string; effort: string } {
    applyThinkingOverride(this.config, thinking);
    if (reasoningEffort) {
      this.config.llm.reasoning_effort = normalizeReasoningEffort(reasoningEffort);
    }
    this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
    return this.client.getThinking();
  }

  getRuntime() {
    return {
      model: this.client.getModel(),
      thinking: this.client.getThinking().mode,
      reasoning_effort: this.client.getThinking().effort,
    };
  }


  setSystemSuffix(suffix: string): void {
    const sys = this.messages[0];
    if (!sys || sys.role !== "system") return;
    const marker = "\n\n[MODE:";
    const base = sys.content ? (sys.content as string).split(marker)[0] : "";
    sys.content = suffix ? base + "\n\n[MODE: " + suffix + "]" : base;
  }
  getMessages(): Message[] {
    return this.messages;
  }

  getLastUserMessage(): string | null {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role === "user" && message.content) return message.content;
    }
    return null;
  }

  restoreMessages(messages: Message[]) {
    this.messages = messages;
  }

  compactContext(keepRecent = 12): string {
    if (this.messages.length <= keepRecent + 1) {
      return "Context is already compact.";
    }
    const system = this.messages[0];
    const oldMessages = this.messages.slice(1, -keepRecent);
    const recent = this.messages.slice(-keepRecent);
    const summary = summarizeMessages(oldMessages);
    this.messages = [
      system,
      {
        role: "system",
        content: `Conversation summary before compaction:\n${summary}`,
      },
      ...recent,
    ];
    return `Compacted ${oldMessages.length} messages; kept ${recent.length} recent messages.`;
  }

  async run(userMessage: string, events: AgentEvents = {}): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });
    return this.complete(events);
  }

  async retryLast(events: AgentEvents = {}): Promise<string> {
    const lastUser = this.getLastUserMessage();
    if (!lastUser) throw new Error("No previous user message to retry.");
    while (this.messages.length > 0 && this.messages[this.messages.length - 1].role !== "user") {
      this.messages.pop();
    }
    return this.complete(events);
  }

  private async complete(events: AgentEvents = {}): Promise<string> {

    const allTools = [...getToolDefs(), ...this.mcpManager.getToolDefs()];

    for (let i = 0; i < this.maxIterations; i++) {
      events.onThinking?.(i + 1);
      const result = await this.client.complete({
        messages: this.messages,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      events.onUsage?.(this.client.getModel(), result.usage);

      if (result.tool_calls.length === 0) {
        const reply = result.content || "";
        this.messages.push({
          role: "assistant",
          content: reply,
          reasoning_content: result.reasoning_content,
        });
        return reply;
      }

      this.messages.push({
        role: "assistant",
        content: result.content || "",
        reasoning_content: result.reasoning_content,
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

  private registerRuntimeTool() {
    registerTool(
      "configure_deepseek_runtime",
      "Switch the DeepSeek model and thinking mode for subsequent calls. Use this before harder reasoning tasks or switch back to flash/chat for routine work.",
      {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Model or alias: pro, flash, chat, reasoner, or a full DeepSeek model name",
          },
          thinking: {
            type: "string",
            enum: ["auto", "enabled", "disabled", "high", "max"],
            description: "Thinking mode. high/max enable thinking and set reasoning effort.",
          },
          reasoning_effort: {
            type: "string",
            enum: ["high", "max"],
            description: "Reasoning effort when thinking is enabled.",
          },
        },
      },
      async ({ model, thinking, reasoning_effort }) => {
        try {
          if (typeof model === "string" && model.trim()) {
            this.setModel(model);
          }
          if (typeof thinking === "string" && thinking.trim()) {
            this.setThinking(thinking, typeof reasoning_effort === "string" ? reasoning_effort : undefined);
          } else if (typeof reasoning_effort === "string" && reasoning_effort.trim()) {
            this.config.llm.reasoning_effort = normalizeReasoningEffort(reasoning_effort);
            this.client.setThinking(this.config.llm.thinking, this.config.llm.reasoning_effort);
          }
          return { output: JSON.stringify(this.getRuntime()) };
        } catch (err: any) {
          return { output: `Error: ${safeErrorMessage(err)}`, error: true };
        }
      }
    );
  }
}

const RUNTIME_SWITCHING_PROMPT = `Runtime switching:
- You may call configure_deepseek_runtime to switch between pro/flash/chat/reasoner and thinking modes.
- Use flash or chat for routine text, search, and simple file tasks.
- Use pro or enabled thinking for complex debugging, architecture review, or multi-step reasoning.
- The official V4 matrix supports both pro and flash with thinking enabled or disabled.
- Switch only when it materially improves quality or cost; otherwise keep the current runtime.`;

function summarizeMessages(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const content = message.content || "";
      const toolCalls = message.tool_calls?.map((call) => call.function.name).join(", ");
      const suffix = toolCalls ? ` tool_calls=[${toolCalls}]` : "";
      return `${index + 1}. ${message.role}${suffix}: ${content.slice(0, 500)}`;
    })
    .join("\n");
}

export interface AgentEvents {
  onThinking?: (iteration: number) => void;
  onToolStart?: (name: string, args: Record<string, any>) => void;
  onToolEnd?: (name: string, elapsedMs: number, error: boolean) => void;
  onUsage?: (model: string, usage: Usage) => void;
}
