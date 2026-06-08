/**
 * compaction.ts — context-window compaction planner for WEIPING_WHALE.
 *
 * Ported from CodeWhale's compaction design. Rather than blindly truncating,
 * we PIN messages worth keeping verbatim (recent tail, errors, patches, working-
 * set file mentions) and only summarize the rest. Tool-call/tool-result pairs
 * are kept together so the transcript stays valid for the provider.
 */
import type { Message } from "./llm/deepseek.js";

export interface CompactionPlan {
  pinned: number[]; // indices kept verbatim (sorted asc)
  summarize: number[]; // indices to fold into a summary (sorted asc)
}

const KEEP_RECENT = 4;
const WORKING_SET_SCAN = 12;
const MAX_WORKING_SET = 24;
const MIN_SUMMARIZE = 6;

const ERROR_MARKERS = [
  "error:", "panic", "failed", "traceback", "stack trace", "assertion failed",
  "exception", "fatal", "cannot find", "is not defined", "unexpected",
];
const PATCH_MARKERS = ["diff --git", "+++ b/", "--- a/", "@@ "];

/** Path-like token extractor (relative or root config files). */
const PATH_RE =
  /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|cc|cpp|h|hpp|toml|md|json|ya?ml|txt|lock|sh|sql))\b/g;
const ROOT_FILES = new Set([
  "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "README.md",
  "CHANGELOG.md", "tsconfig.json", "config.toml",
]);

function messageText(m: Message): string {
  let s = typeof m.content === "string" ? m.content : "";
  if (m.tool_calls?.length) {
    for (const tc of m.tool_calls) {
      s += " " + tc.function.name + " " + (tc.function.arguments ?? "");
    }
  }
  return s;
}

function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(/\s+/)) {
    if (ROOT_FILES.has(w)) out.add(w);
  }
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const p = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p.includes("..")) out.add(p);
  }
  return [...out];
}

/** Build the working set: file paths mentioned in the most recent messages. */
export function deriveWorkingSet(messages: Message[], extraPins: string[] = []): string[] {
  const set = new Set<string>(extraPins);
  const start = Math.max(0, messages.length - WORKING_SET_SCAN);
  for (let i = start; i < messages.length; i++) {
    for (const p of extractPaths(messageText(messages[i]))) set.add(p);
  }
  return [...set].slice(0, MAX_WORKING_SET);
}

/**
 * Decide which message indices to pin vs summarize. The system message (index 0)
 * is always pinned; the last KEEP_RECENT messages are always pinned.
 */
export function planCompaction(messages: Message[], workingSet: string[] = []): CompactionPlan {
  const n = messages.length;
  const pinned = new Set<number>();

  // Always pin a leading system message.
  if (n > 0 && messages[0].role === "system") pinned.add(0);

  // Always pin the recent tail.
  for (let i = Math.max(0, n - KEEP_RECENT); i < n; i++) pinned.add(i);

  const ws = workingSet.length ? workingSet : deriveWorkingSet(messages);

  // Heuristic pins: errors, patches, working-set mentions.
  for (let i = 0; i < n; i++) {
    const text = messageText(messages[i]).toLowerCase();
    if (!text) continue;
    if (ERROR_MARKERS.some((mk) => text.includes(mk))) {
      pinned.add(i);
      continue;
    }
    if (PATCH_MARKERS.some((mk) => text.includes(mk))) {
      pinned.add(i);
      continue;
    }
    if (ws.some((p) => text.includes(p.toLowerCase()))) {
      pinned.add(i);
    }
  }

  // Enforce tool-call/result pairing: if a tool result is pinned, pin its call,
  // and vice versa. Iterate to a fixpoint.
  const callIndexById = new Map<string, number>();
  const resultIndexById = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) callIndexById.set(tc.id, i);
    }
    if (m.role === "tool" && m.tool_call_id) resultIndexById.set(m.tool_call_id, i);
  }
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const [id, resIdx] of resultIndexById) {
      const callIdx = callIndexById.get(id);
      if (callIdx == null) continue;
      if (pinned.has(resIdx) && !pinned.has(callIdx)) { pinned.add(callIdx); changed = true; }
      if (pinned.has(callIdx) && !pinned.has(resIdx)) { pinned.add(resIdx); changed = true; }
    }
    if (!changed) break;
  }

  // A tool result must never be the first kept message after the system prompt
  // with no preceding assistant call — but pairing above handles that. Also make
  // sure at least one user message survives in the kept set.
  const hasUser = [...pinned].some((i) => messages[i].role === "user");
  if (!hasUser) {
    for (let i = n - 1; i >= 0; i--) {
      if (messages[i].role === "user") { pinned.add(i); break; }
    }
  }

  const summarize: number[] = [];
  for (let i = 0; i < n; i++) if (!pinned.has(i)) summarize.push(i);

  return { pinned: [...pinned].sort((a, b) => a - b), summarize };
}

/** Whether compaction is worthwhile given the plan. */
export function shouldCompact(plan: CompactionPlan): boolean {
  return plan.summarize.length >= MIN_SUMMARIZE;
}

/** Build the summarization input string (head/tail trimmed) for the model. */
export function buildSummaryInput(messages: Message[], summarizeIdx: number[], largeContext = false): string {
  const textSnippet = largeContext ? 2000 : 800;
  const toolSnippet = largeContext ? 4000 : 240;
  const headChars = largeContext ? 72000 : 14000;
  const tailChars = largeContext ? 36000 : 6000;

  const parts: string[] = [];
  for (const i of summarizeIdx) {
    const m = messages[i];
    const role = m.role;
    if (m.role === "tool") {
      const body = (typeof m.content === "string" ? m.content : "").slice(0, toolSnippet);
      parts.push(`[${role} result] ${body}`);
    } else {
      const body = (typeof m.content === "string" ? m.content : "").slice(0, textSnippet);
      const calls = m.tool_calls?.map((t) => t.function.name).join(",") ?? "";
      parts.push(`[${role}${calls ? ` calls=${calls}` : ""}] ${body}`);
    }
  }
  let joined = parts.join("\n");
  if (joined.length > headChars + tailChars) {
    joined = joined.slice(0, headChars) + "\n…[omitted middle]…\n" + joined.slice(-tailChars);
  }
  return joined;
}

export const SUMMARY_SYSTEM_PROMPT =
  "You are compacting a coding-agent transcript. Summarize the following messages " +
  "concisely (~500 words max), PRESERVING: file paths touched, key decisions, error " +
  "messages and their resolutions, and any unfinished work. Omit pleasantries and " +
  "redundant tool chatter. Output only the summary.";
