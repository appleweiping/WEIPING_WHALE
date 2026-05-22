import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import TOML from "@iarna/toml";

export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Config {
  config_path?: string;
  llm: {
    model: string;
    api_key: string;
    base_url: string;
    temperature: number;
    max_tokens: number;
    thinking: ThinkingMode;
    reasoning_effort: ReasoningEffort;
  };
  agent: {
    max_iterations: number;
    workspace: string;
    system_prompt: string;
  };
  mcp_servers: Record<string, MCPServerConfig>;
}

export type ThinkingMode = "auto" | "enabled" | "disabled";
export type ReasoningEffort = "high" | "max";

export interface RuntimeOverrides {
  model?: string;
  thinking?: string;
  reasoning_effort?: string;
}

export interface ModelPreset {
  name: string;
  model: string;
  thinking: ThinkingMode;
  description: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    name: "pro",
    model: "deepseek-v4-pro",
    thinking: "auto",
    description: "Highest-quality V4 model; best for complex coding, architecture, and debugging.",
  },
  {
    name: "pro-thinking",
    model: "deepseek-v4-pro",
    thinking: "enabled",
    description: "Pro with thinking explicitly enabled.",
  },
  {
    name: "pro-non-thinking",
    model: "deepseek-v4-pro",
    thinking: "disabled",
    description: "Pro with thinking explicitly disabled for lower latency.",
  },
  {
    name: "flash",
    model: "deepseek-v4-flash",
    thinking: "auto",
    description: "Fast, economical V4 model; good default for routine agent work.",
  },
  {
    name: "flash-thinking",
    model: "deepseek-v4-flash",
    thinking: "enabled",
    description: "Flash with thinking explicitly enabled.",
  },
  {
    name: "flash-non-thinking",
    model: "deepseek-v4-flash",
    thinking: "disabled",
    description: "Flash with thinking disabled; equivalent to the legacy deepseek-chat path.",
  },
];

const MODEL_ALIASES: Record<string, ModelOverride> = {
  pro: { model: "deepseek-v4-pro" },
  "v4-pro": { model: "deepseek-v4-pro" },
  flash: { model: "deepseek-v4-flash" },
  "v4-flash": { model: "deepseek-v4-flash" },
  chat: { model: "deepseek-v4-flash", thinking: "disabled" },
  reasoner: { model: "deepseek-v4-flash", thinking: "enabled" },
  "deepseek-chat": { model: "deepseek-v4-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-v4-flash", thinking: "enabled" },
  "pro-thinking": { model: "deepseek-v4-pro", thinking: "enabled" },
  "pro-think": { model: "deepseek-v4-pro", thinking: "enabled" },
  "pro-non-thinking": { model: "deepseek-v4-pro", thinking: "disabled" },
  "pro-no-thinking": { model: "deepseek-v4-pro", thinking: "disabled" },
  "flash-thinking": { model: "deepseek-v4-flash", thinking: "enabled" },
  "flash-think": { model: "deepseek-v4-flash", thinking: "enabled" },
  "flash-non-thinking": { model: "deepseek-v4-flash", thinking: "disabled" },
  "flash-no-thinking": { model: "deepseek-v4-flash", thinking: "disabled" },
};

interface ModelOverride {
  model: string;
  thinking?: ThinkingMode;
}

const DEFAULT_CONFIG: Config = {
  config_path: undefined,
  llm: {
    model: "deepseek-v4-flash",
    api_key: "",
    base_url: "https://api.deepseek.com",
    temperature: 0.3,
    max_tokens: 4096,
    thinking: "enabled",
    reasoning_effort: "high",
  },
  agent: {
    max_iterations: 50,
    workspace: ".",
    system_prompt: "",
  },
  mcp_servers: {},
};

export function loadConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const configPaths = [
    process.env.DEEPSEEK_CONFIG,
    join(process.cwd(), "deepseek-cli.toml"),
    join(process.cwd(), ".deepseek-cli.toml"),
    join(homedir(), ".deepseek-cli", "config.toml"),
    join(packageRoot, "config.toml"),
  ];

  for (const p of configPaths) {
    if (p && existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = TOML.parse(raw) as any;
      mergeConfig(config, parsed);
      config.config_path = p;
      break;
    }
  }

  applyModelOverride(config, config.llm.model);
  config.llm.thinking = normalizeThinkingMode(String(config.llm.thinking));
  config.llm.reasoning_effort = normalizeReasoningEffort(String(config.llm.reasoning_effort));

  // Environment variable overrides
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) config.llm.api_key = envKey;

  const envModel = process.env.DEEPSEEK_MODEL;
  if (envModel) applyModelOverride(config, envModel);

  const envThinking = process.env.DEEPSEEK_THINKING;
  if (envThinking) applyThinkingOverride(config, envThinking);

  const envReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT;
  if (envReasoningEffort) config.llm.reasoning_effort = normalizeReasoningEffort(envReasoningEffort);

  const envBase = process.env.DEEPSEEK_BASE_URL;
  if (envBase) config.llm.base_url = envBase;

  // Resolve api_key_env indirection
  if (!config.llm.api_key && (config.llm as any).api_key_env) {
    config.llm.api_key = process.env[(config.llm as any).api_key_env] || "";
  }

  return config;
}

export function applyRuntimeOverrides(config: Config, overrides: RuntimeOverrides): Config {
  if (overrides.model) applyModelOverride(config, overrides.model);
  if (overrides.thinking) applyThinkingOverride(config, overrides.thinking);
  if (overrides.reasoning_effort) {
    config.llm.reasoning_effort = normalizeReasoningEffort(overrides.reasoning_effort);
  }
  return config;
}

export function normalizeModelName(input: string): string {
  return resolveModelOverride(input).model;
}

export function applyModelOverride(config: Config, input: string): Config {
  const override = resolveModelOverride(input);
  config.llm.model = override.model;
  if (override.thinking) config.llm.thinking = override.thinking;
  return config;
}

function resolveModelOverride(input: string): ModelOverride {
  const normalized = input.trim().toLowerCase();
  return MODEL_ALIASES[normalized] ?? { model: input.trim() };
}

export function normalizeThinkingMode(input: string): ThinkingMode {
  const normalized = input.trim().toLowerCase();
  if (["auto", "default"].includes(normalized)) return "enabled";
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) return "enabled";
  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) return "disabled";
  if (["high", "max", "low", "medium", "xhigh"].includes(normalized)) return "enabled";
  throw new Error(`Invalid thinking mode: ${input}. Use auto, enabled, disabled, high, or max.`);
}

export function normalizeReasoningEffort(input: string): ReasoningEffort {
  const normalized = input.trim().toLowerCase();
  if (["high", "low", "medium"].includes(normalized)) return "high";
  if (["max", "xhigh"].includes(normalized)) return "max";
  throw new Error(`Invalid reasoning effort: ${input}. Use high or max.`);
}

export function applyThinkingOverride(config: Config, input: string): Config {
  const normalized = input.trim().toLowerCase();
  config.llm.thinking = normalizeThinkingMode(input);
  if (["high", "low", "medium", "max", "xhigh"].includes(normalized)) {
    config.llm.reasoning_effort = normalizeReasoningEffort(input);
  }
  return config;
}

function mergeConfig(target: any, source: any) {
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object"
    ) {
      mergeConfig(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}
