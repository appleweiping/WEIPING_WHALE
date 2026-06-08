import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "./llm/deepseek.js";
import { compact, redactSecrets, safeErrorMessage } from "./runtime/safe-text.js";
import { memoryOutboxDir as resolveMemoryOutboxDir } from "./runtime/paths.js";

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
    const fallbackPath = writeMemoryOutbox(snapshot, content);
    return { agentmemory: false, fallbackPath, error: `agentmemory HTTP ${response.status}` };
  } catch (err: any) {
    const fallbackPath = writeMemoryOutbox(snapshot, content);
    return { agentmemory: false, fallbackPath, error: safeErrorMessage(err) };
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
  if (snapshot.note) lines.push(`note: ${redactSecrets(snapshot.note).slice(0, 1000)}`);
  if (snapshot.error) lines.push(`error: ${redactSecrets(snapshot.error).slice(0, 1000)}`);
  if (lastUser) lines.push(`last_user: ${lastUser}`);
  if (lastAssistant) lines.push(`last_assistant: ${lastAssistant}`);
  return lines.join("\n");
}

function writeMemoryOutbox(snapshot: SessionMemorySnapshot, content: string): string {
  const dir = memoryOutboxDir();
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

export function memoryOutboxDir(): string {
  return resolveMemoryOutboxDir();
}

export function memoryDiagnostics() {
  const enabled = !isMemoryDisabled();
  const explicitUrl = Boolean(process.env.AGENTMEMORY_URL);
  return {
    enabled,
    agentmemory_url_configured: explicitUrl,
    agentmemory_endpoint: explicitUrl ? "explicit" : "default",
    agentmemory_endpoint_configured: enabled,
    outbox_dir: memoryOutboxDir(),
    legacy_shared_memory_disabled: true,
  };
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
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((b) => (b.type === "text" ? b.text : "[image]")).join(" ");
    return compact(redactSecrets(text), 1200);
  }
  return null;
}
