import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import type { Message } from "./llm/deepseek.js";
import { safeErrorMessage } from "./runtime/safe-text.js";

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
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
  } catch {
    return null;
  }
}

export function saveSession(id: string, cwd: string, runtime: Record<string, string>, messages: Message[]) {
  const path = sessionPath(id);
  mkdirSync(dirname(path), { recursive: true });
  const previous = readSessionFile(path);
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

export function listSessions(limit = 10): SessionState[] {
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, Math.max(1, limit))
    .flatMap((path) => {
      const session = readSessionFile(path);
      return session ? [session] : [];
    });
}

export function formatSessionInfo(id: string): string {
  return `session: ${id}\npath: ${sessionPath(id)}`;
}

export function sessionDir(): string {
  return resolve(homedir(), ".deepseek-cli", "sessions");
}

function sanitizeSessionId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
  return sanitized || createSessionId();
}

function readSessionFile(path: string): SessionState | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
  } catch (err) {
    if (process.env.DEEPSEEK_DEBUG_SESSIONS === "1") {
      process.stderr.write(`[sessions] skipped corrupt session ${path}: ${safeErrorMessage(err)}\n`);
    }
    return null;
  }
}
