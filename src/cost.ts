/**
 * cost.ts — live cost + prefix-cache tracking for WEIPING_WHALE.
 *
 * DeepSeek bills cache-hit input tokens far cheaper than cache-miss tokens, so
 * we track hits/misses separately and surface a footer chip whose color warns
 * when the cache-hit ratio drops (a signal to consolidate context). Prices are
 * per 1M tokens, USD. They are best-effort defaults and configurable.
 */
import type { Usage } from "./llm/deepseek.js";

export interface ModelPricing {
  cache_hit_usd: number; // per 1M input tokens served from prefix cache
  cache_miss_usd: number; // per 1M input tokens not cached
  output_usd: number; // per 1M output tokens
}

// Best-effort default pricing (per 1M tokens, USD). Override via config [pricing].
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-pro": { cache_hit_usd: 0.07, cache_miss_usd: 0.56, output_usd: 1.68 },
  "deepseek-v4-flash": { cache_hit_usd: 0.014, cache_miss_usd: 0.14, output_usd: 0.28 },
};

const FALLBACK_PRICING: ModelPricing = DEFAULT_PRICING["deepseek-v4-flash"];

export interface CostState {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  turns: number;
}

export class CostTracker {
  private state: CostState = {
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
    turns: 0,
  };
  private pricing: Record<string, ModelPricing>;

  constructor(overrides?: Record<string, Partial<ModelPricing>>) {
    this.pricing = { ...DEFAULT_PRICING };
    if (overrides) {
      for (const [model, p] of Object.entries(overrides)) {
        this.pricing[model] = { ...(this.pricing[model] ?? FALLBACK_PRICING), ...p };
      }
    }
  }

  private priceFor(model: string): ModelPricing {
    return this.pricing[model] ?? FALLBACK_PRICING;
  }

  /** Record a single completion's usage against a model. */
  record(model: string, usage: Usage): void {
    const price = this.priceFor(model);
    const prompt = clampInt(usage.prompt_tokens);
    const completion = clampInt(usage.completion_tokens);

    const hasHit = usage.prompt_cache_hit_tokens != null;
    const hasMiss = usage.prompt_cache_miss_tokens != null;
    let hit: number;
    let miss: number;
    if (hasHit && hasMiss) {
      hit = clampInt(usage.prompt_cache_hit_tokens);
      miss = clampInt(usage.prompt_cache_miss_tokens);
    } else if (hasHit) {
      hit = clampInt(usage.prompt_cache_hit_tokens);
      miss = Math.max(0, prompt - hit); // derive the missing side from prompt
    } else if (hasMiss) {
      miss = clampInt(usage.prompt_cache_miss_tokens);
      hit = Math.max(0, prompt - miss); // derive hits, don't drop them to zero
    } else {
      // Neither reported: attribute everything to miss (conservative, higher cost).
      hit = 0;
      miss = prompt;
    }

    this.state.promptTokens += prompt;
    this.state.completionTokens += completion;
    this.state.cacheHitTokens += hit;
    this.state.cacheMissTokens += miss;
    this.state.turns += 1;

    this.state.costUsd +=
      (hit / 1_000_000) * price.cache_hit_usd +
      (miss / 1_000_000) * price.cache_miss_usd +
      (completion / 1_000_000) * price.output_usd;
  }

  snapshot(): CostState {
    return { ...this.state };
  }

  /** Cache-hit ratio over all prompt tokens seen (0..1), or null if no input yet. */
  cacheHitRatio(): number | null {
    const total = this.state.cacheHitTokens + this.state.cacheMissTokens;
    if (total === 0) return null;
    return this.state.cacheHitTokens / total;
  }

  /** A compact one-line footer chip, e.g. "$0.0123 · 12.3k tok · cache 82%". */
  footer(): string {
    const s = this.state;
    const totalTok = s.promptTokens + s.completionTokens;
    const ratio = this.cacheHitRatio();
    const cacheStr = ratio == null ? "cache n/a" : `cache ${Math.round(ratio * 100)}%`;
    return `$${s.costUsd.toFixed(4)} · ${formatTokens(totalTok)} tok · ${cacheStr}`;
  }

  /** Color hint for the cache chip: red <40%, yellow <80%, green otherwise. */
  cacheColor(): "red" | "yellow" | "green" | "none" {
    const ratio = this.cacheHitRatio();
    if (ratio == null) return "none";
    if (ratio < 0.4) return "red";
    if (ratio < 0.8) return "yellow";
    return "green";
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Coerce a usage figure to a finite, non-negative integer. */
function clampInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}