import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import TOML from "@iarna/toml";

export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Config {
  llm: {
    model: string;
    api_key: string;
    base_url: string;
    temperature: number;
    max_tokens: number;
  };
  agent: {
    max_iterations: number;
    workspace: string;
    system_prompt: string;
  };
  mcp_servers: Record<string, MCPServerConfig>;
}

const DEFAULT_CONFIG: Config = {
  llm: {
    model: "deepseek-chat",
    api_key: "",
    base_url: "https://api.deepseek.com",
    temperature: 0.3,
    max_tokens: 4096,
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

  const configPaths = [
    join(homedir(), ".deepseek-cli", "config.toml"),
    join(process.cwd(), "deepseek-cli.toml"),
  ];

  for (const p of configPaths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = TOML.parse(raw) as any;
      mergeConfig(config, parsed);
      break;
    }
  }

  // Environment variable overrides
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) config.llm.api_key = envKey;

  const envModel = process.env.DEEPSEEK_MODEL;
  if (envModel) config.llm.model = envModel;

  const envBase = process.env.DEEPSEEK_BASE_URL;
  if (envBase) config.llm.base_url = envBase;

  // Resolve api_key_env indirection
  if (!config.llm.api_key && (config.llm as any).api_key_env) {
    config.llm.api_key = process.env[(config.llm as any).api_key_env] || "";
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
