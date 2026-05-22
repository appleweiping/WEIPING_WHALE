import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "./llm/deepseek.js";

export interface SessionMemorySnapshot {
  sessionId: string;
  cwd: string;
  runtime: Record<string, string>;
  messages: Message[];
  status: "closed" | "interrupted" | "error" | "manual" | "completed";
  note?: string;
  error?: string;
  files?: string[];
}

export interface SessionMemoryResult {
  agentmemory: boolean;
  fallbackPath?: string;
  skipped?: boolean;
  error?: string;
}

const DEFAULT_AGENTMEMORY_URL = "http://localhost:3111";
const DEFAULT_SHARED_MEMORY = "D:\\research\\Vipin's Knowledgebase\\memory";

export async function saveSessionMemory(snapshot: SessionMemorySnapshot): Promise<SessionMemoryResult> {
  if (isMemoryDisabled()) return { agentmemory: false, skipped: true };

  const content = formatSessionMemory(snapshot);
  const payload = {
    content,
    type: snapshot.status === "error" ? "bug" : "fact",
    concepts: ["deepseek-cli", "session", "autosave", snapshot.status],
    files: snapshot.files ?? [],
  };

  try {
    const response = await fetch(`${agentMemoryBaseUrl()}/agentmemory/remember`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_500),
    });
    if (response.ok) return { agentmemory: true };
    const text = await response.text();
    const fallbackPath = writeMemoryOutbox(snapshot, content);
    return { agentmemory: false, fallbackPath, error: `agentmemory HTTP ${response.status}: ${text.slice(0, 200)}` };
  } catch (err: any) {
    const fallbackPath = writeMemoryOutbox(snapshot, content);
    return { agentmemory: false, fallbackPath, error: err?.message ?? String(err) };
  }
}

export function formatSessionMemory(snapshot: SessionMemorySnapshot): string {
  const lastUser = lastMessage(snapshot.messages, "user");
  const lastAssistant = lastMessage(snapshot.messages, "assistant");
  const lines = [
    `DeepSeek CLI session ${snapshot.sessionId} ${snapshot.status}.`,
    `cwd: ${snapshot.cwd}`,
    `runtime: model=${snapshot.runtime.model ?? "unknown"}, thinking=${snapshot.runtime.thinking ?? "unknown"}, reasoning_effort=${snapshot.runtime.reasoning_effort ?? "unknown"}`,
    `messages: ${snapshot.messages.length}`,
  ];
  if (snapshot.note) lines.push(`note: ${snapshot.note.slice(0, 1000)}`);
  if (snapshot.error) lines.push(`error: ${snapshot.error.slice(0, 1000)}`);
  if (lastUser) lines.push(`last_user: ${lastUser}`);
  if (lastAssistant) lines.push(`last_assistant: ${lastAssistant}`);
  return lines.join("\n");
}

function writeMemoryOutbox(snapshot: SessionMemorySnapshot, content: string): string {
  const root = sharedMemoryRoot();
  const dir = root ? join(root, "sessions") : join(homedir(), ".deepseek-cli", "memory-outbox");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `deepseek-cli-${snapshot.status}-${stamp}.md`);
  const body = [
    "---",
    `title: "DeepSeek CLI ${snapshot.status} autosave ${snapshot.sessionId}"`,
    "type: fact",
    `created: ${new Date().toISOString()}`,
    "tags: [deepseek-cli, session, autosave]",
    "---",
    "",
    content,
    "",
  ].join("\n");
  writeFileSync(path, body, "utf-8");
  return path;
}

function sharedMemoryRoot(): string | null {
  const configured = process.env.DEEPSEEK_SHARED_MEMORY_DIR;
  if (configured) return configured;
  return existsSync(DEFAULT_SHARED_MEMORY) ? DEFAULT_SHARED_MEMORY : null;
}

function agentMemoryBaseUrl(): string {
  return (process.env.AGENTMEMORY_URL || DEFAULT_AGENTMEMORY_URL).replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.AGENTMEMORY_SECRET;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

function isMemoryDisabled(): boolean {
  const explicitDisable = process.env.DEEPSEEK_DISABLE_AGENTMEMORY?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicitDisable ?? "")) return true;
  const enabled = process.env.DEEPSEEK_AGENTMEMORY?.trim().toLowerCase();
  return ["0", "false", "no", "off"].includes(enabled ?? "");
}

function lastMessage(messages: Message[], role: Message["role"]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== role || !message.content) continue;
    return compact(message.content, 1200);
  }
  return null;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

