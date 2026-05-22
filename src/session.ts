import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { Message } from "./llm/deepseek.js";

export interface SessionState {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  runtime: Record<string, string>;
  messages: Message[];
}

export function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${stamp}`;
}

export function sessionPath(id: string): string {
  return join(sessionDir(), `${sanitizeSessionId(id)}.json`);
}

export function loadSession(id: string): SessionState | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
}

export function saveSession(id: string, cwd: string, runtime: Record<string, string>, messages: Message[]) {
  const path = sessionPath(id);
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as SessionState) : null;
  const state: SessionState = {
    id,
    created_at: previous?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cwd,
    runtime,
    messages,
  };
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function formatSessionInfo(id: string): string {
  return `session: ${id}\npath: ${sessionPath(id)}`;
}

function sessionDir(): string {
  return join(homedir(), ".deepseek-cli", "sessions");
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
