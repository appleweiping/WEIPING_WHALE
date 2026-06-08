import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Message } from "./llm/deepseek.js";
import { safeErrorMessage } from "./runtime/safe-text.js";
import { sessionsDir } from "./runtime/paths.js";

export interface SessionState {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  runtime: Record<string, string>;
  messages: Message[];
  /** Schema version for forward-compat. Absent = legacy v0. */
  schema_version?: number;
  /** Human title derived from the first user message. */
  title?: string;
  /** Set when this session was forked from another. */
  parent_session_id?: string;
  /** Message count in the parent at fork time. */
  forked_from_message_count?: number;
  /** Cumulative token + cost bookkeeping (best-effort). */
  total_tokens?: number;
  cost?: { usd: number; cny: number };
}

export const SESSION_SCHEMA_VERSION = 1;

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
  return readSessionFile(path);
}

export interface SaveSessionExtras {
  parent_session_id?: string;
  forked_from_message_count?: number;
  total_tokens?: number;
  cost?: { usd: number; cny: number };
}

export function saveSession(
  id: string,
  cwd: string,
  runtime: Record<string, string>,
  messages: Message[],
  extras: SaveSessionExtras = {},
) {
  const path = sessionPath(id);
  mkdirSync(dirname(path), { recursive: true });
  const previous = readSessionFile(path);
  const state: SessionState = {
    id,
    schema_version: SESSION_SCHEMA_VERSION,
    title: previous?.title ?? deriveTitle(messages),
    created_at: previous?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cwd,
    runtime,
    messages,
    parent_session_id: extras.parent_session_id ?? previous?.parent_session_id,
    forked_from_message_count: extras.forked_from_message_count ?? previous?.forked_from_message_count,
    total_tokens: extras.total_tokens ?? previous?.total_tokens,
    cost: extras.cost ?? previous?.cost,
  };
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  pruneSessionsToCap();
}

/**
 * Fork the given session into a new branchable session that shares history up
 * to the fork point. Returns the new session id, or null if the source is
 * missing/empty.
 */
export function forkSession(sourceId: string, cwd: string, runtime: Record<string, string>): string | null {
  const source = loadSession(sourceId);
  if (!source || source.messages.length === 0) return null;
  // Persist the parent first so its metadata is up to date.
  saveSession(sourceId, source.cwd ?? cwd, source.runtime ?? runtime, source.messages);
  const childId = createSessionId() + "-fork";
  saveSession(childId, cwd, runtime, [...source.messages], {
    parent_session_id: sourceId,
    forked_from_message_count: source.messages.length,
    total_tokens: source.total_tokens,
    cost: source.cost,
  });
  return childId;
}

/**
 * Resolve a session reference: exact id, unique id prefix, or "last"/"--last"
 * (most recently updated session). Returns the resolved SessionState or an
 * error describing why it could not be resolved.
 */
export function resolveSessionRef(ref: string): { session?: SessionState; error?: string } {
  const trimmed = ref.trim().replace(/^--?/, "");
  if (trimmed === "last" || trimmed === "") {
    const recent = listSessions(1);
    if (recent.length === 0) return { error: "no saved sessions to resume" };
    return { session: recent[0] };
  }
  // Exact match first.
  const exact = loadSession(trimmed);
  if (exact) return { session: exact };
  // Prefix match across all sessions.
  const all = listSessions(1000);
  const matches = all.filter((s) => s.id.startsWith(trimmed));
  if (matches.length === 0) return { error: `no session matching '${ref}'` };
  if (matches.length > 1) return { error: `ambiguous session prefix '${ref}' (${matches.length} matches)` };
  return { session: matches[0] };
}

/**
 * Backtrack: return a copy of messages truncated so the conversation rewinds to
 * just before the Nth-from-last user message (default 1 = undo last exchange).
 * Preserves the leading system message.
 */
export function backtrackMessages(messages: Message[], stepsBack = 1): Message[] {
  if (messages.length === 0) return messages;
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return messages;
  const targetPos = userIndices.length - stepsBack;
  if (targetPos < 0) {
    // Rewind everything but the system prompt.
    return messages[0]?.role === "system" ? [messages[0]] : [];
  }
  const cut = userIndices[targetPos];
  return messages.slice(0, cut);
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
  return sessionsDir();
}

const MAX_SESSIONS = 200;

/** Keep at most MAX_SESSIONS session files; delete the oldest beyond the cap. */
function pruneSessionsToCap(): void {
  try {
    const dir = sessionDir();
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const stale of files.slice(MAX_SESSIONS)) {
      try {
        rmSync(stale, { force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim());
  const text = (firstUser?.content as string) ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "untitled session";
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
