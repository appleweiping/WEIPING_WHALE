import type { ToolDef } from "../llm/deepseek.js";

export interface ToolResult {
  output: string;
  error?: boolean;
}

export type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDef;
  handler: ToolHandler;
}

const tools = new Map<string, RegisteredTool>();

export function registerTool(
  name: string,
  description: string,
  parameters: Record<string, any>,
  handler: ToolHandler
) {
  tools.set(name, {
    definition: {
      type: "function",
      function: { name, description, parameters },
    },
    handler,
  });
}

export function getToolDefs(): ToolDef[] {
  return Array.from(tools.values()).map((t) => t.definition);
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

export function getAllTools(): Map<string, RegisteredTool> {
  return tools;
}
