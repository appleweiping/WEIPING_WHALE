/**
 * router.ts — "Fin" auto model/effort router for WEIPING_WHALE.
 *
 * Ported from CodeWhale's auto_reasoning design: a fast, zero-cost keyword
 * heuristic (NOT an extra LLM call) that picks a reasoning effort — and from it
 * a model preset — per turn, based on the latest user message. Multilingual
 * (English + CJK) keyword sets, defaulting to the middle tier.
 *
 * Decision:
 *   - sub-agent context        -> low
 *   - high-effort keywords     -> max  (debug/error/crash/architecture/...)
 *   - low-effort keywords      -> low  (search/lookup/format/rename/...)
 *   - otherwise                -> high (sensible default)
 */
export type RouteEffort = "low" | "high" | "max";

export interface RouteDecision {
  effort: RouteEffort;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  thinking: "disabled" | "enabled";
  reasoning_effort: "high" | "max";
  reason: string;
}

const HIGH_KEYWORDS = [
  // English
  "debug", "error", "crash", "panic", "stack trace", "traceback", "race condition",
  "deadlock", "architecture", "refactor", "design", "why does", "root cause",
  "security", "vulnerability", "optimize", "performance", "concurrency", "prove",
  // CJK (zh/ja)
  "调试", "错误", "报错", "出错", "崩溃", "架构", "重构", "设计", "为什么", "根因",
  "性能", "优化", "安全", "漏洞", "并发", "死锁",
  "デバッグ", "エラー", "バグ", "設計", "リファクタ",
];

const LOW_KEYWORDS = [
  // English
  "search", "lookup", "look up", "find", "list", "format", "rename", "typo",
  "what is", "show me", "print", "echo", "grep", "summarize", "translate",
  // CJK
  "搜索", "查找", "查询", "列出", "格式化", "重命名", "拼写", "翻译", "总结", "显示",
  "検索", "一覧", "翻訳",
];

export interface RouteContext {
  lastUserMessage: string;
  isSubagent?: boolean;
}

/** Decide the route for a turn. Pure, O(message length), no network. */
export function route(ctx: RouteContext): RouteDecision {
  if (ctx.isSubagent) {
    return fromEffort("low", "sub-agent context defaults to low effort");
  }
  const text = (ctx.lastUserMessage ?? "").toLowerCase();
  if (!text.trim()) {
    return fromEffort("high", "empty/blank message -> default high");
  }

  // High-effort wins over low if both appear (be safe on hard tasks).
  const high = HIGH_KEYWORDS.find((k) => text.includes(k));
  if (high) return fromEffort("max", `high-effort keyword "${high}"`);

  const low = LOW_KEYWORDS.find((k) => text.includes(k));
  if (low) return fromEffort("low", `low-effort keyword "${low}"`);

  return fromEffort("high", "no signal -> default high");
}

function fromEffort(effort: RouteEffort, reason: string): RouteDecision {
  switch (effort) {
    case "low":
      return {
        effort,
        model: "deepseek-v4-flash",
        thinking: "disabled",
        reasoning_effort: "high",
        reason,
      };
    case "max":
      return {
        effort,
        model: "deepseek-v4-pro",
        thinking: "enabled",
        reasoning_effort: "max",
        reason,
      };
    case "high":
    default:
      return {
        effort,
        model: "deepseek-v4-flash",
        thinking: "enabled",
        reasoning_effort: "high",
        reason,
      };
  }
}
