import { compact, errorType, safeErrorMessage } from "../runtime/safe-text.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface CompletionOptions {
  messages: Message[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** DeepSeek prefix-cache accounting (present when the provider reports it). */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface CompletionResult {
  content: string | null;
  reasoning_content: string | null;
  tool_calls: ToolCall[];
  usage: Usage;
}

// PLACEHOLDER_STREAMING

export class DeepSeekClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private defaultTemp: number;
  private defaultMaxTokens: number;
  private requestTimeoutMs: number;
  private thinking: "auto" | "enabled" | "disabled";
  private reasoningEffort: "high" | "max";

  constructor(opts: {
    base_url: string;
    api_key: string;
    model: string;
    temperature: number;
    max_tokens: number;
    request_timeout_ms?: number;
    thinking: "auto" | "enabled" | "disabled";
    reasoning_effort: "high" | "max";
  }) {
    this.baseUrl = opts.base_url.replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.model = opts.model;
    this.defaultTemp = opts.temperature;
    this.defaultMaxTokens = opts.max_tokens;
    this.requestTimeoutMs = opts.request_timeout_ms ?? 120000;
    this.thinking = opts.thinking;
    this.reasoningEffort = opts.reasoning_effort;
  }

  setModel(model: string) {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  setThinking(thinking: "auto" | "enabled" | "disabled", reasoningEffort = this.reasoningEffort) {
    this.thinking = thinking;
    this.reasoningEffort = reasoningEffort;
  }

  getThinking(): { mode: "auto" | "enabled" | "disabled"; effort: "high" | "max" } {
    return { mode: this.thinking, effort: this.reasoningEffort };
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    const body: any = {
      model: this.model,
      messages: this.serializeMessages(opts.messages),
      temperature: opts.temperature ?? this.defaultTemp,
      max_tokens: opts.max_tokens ?? this.defaultMaxTokens,
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
    }

    this.applyThinkingParams(body);

    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw this.formatHttpError(res.status, text);
    }

    const data = JSON.parse(text);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    return {
      content: choice.message?.content ?? null,
      reasoning_content: choice.message?.reasoning_content ?? null,
      tool_calls: choice.message?.tool_calls ?? [],
      usage: normalizeUsage(data.usage),
    };
  }

  async *stream(opts: CompletionOptions): AsyncGenerator<string> {
    const body: any = {
      model: this.model,
      messages: this.serializeMessages(opts.messages),
      temperature: opts.temperature ?? this.defaultTemp,
      max_tokens: opts.max_tokens ?? this.defaultMaxTokens,
      stream: true,
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
    }

    this.applyThinkingParams(body);

    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw this.formatHttpError(res.status, text);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {}
      }
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 3
  ): Promise<Response> {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          if (i === retries - 1) return res;
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        return res;
      } catch (err) {
        if (i === retries - 1) throw new Error(this.formatNetworkError(err));
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw new Error(`DeepSeek API retry attempts exhausted after ${retries} attempts`);
  }

  private formatNetworkError(err: unknown): string {
    const name = err instanceof Error ? err.name : "NetworkError";
    const message = safeErrorMessage(err);
    if (name === "TimeoutError" || message.toLowerCase().includes("timeout")) {
      return `DeepSeek API request timed out after ${this.requestTimeoutMs}ms. The session was saved; use /retry after the network recovers.`;
    }
    return `DeepSeek API network error: ${message}. The session was saved; use /retry after the network recovers.`;
  }

  private formatHttpError(status: number, bodyText: string): Error {
    const parsed = parseRemoteError(bodyText);
    const retryHint = status === 429
      ? " Reduce concurrency or retry later."
      : status >= 500
        ? " The provider may be degraded; retry later."
        : "";
    const details = process.env.DEEPSEEK_DEBUG_ERRORS === "1" && parsed.message ? ` remote_message=${parsed.message}` : "";
    return new Error(`DeepSeek API error HTTP_${status} remote_type=${parsed.type}${details}.${retryHint}`.trim());
  }

  private applyThinkingParams(body: Record<string, any>) {
    const thinkingType = this.thinking === "auto" ? "enabled" : this.thinking;
    body.thinking = { type: thinkingType };
    if (thinkingType === "enabled") {
      delete body.temperature;
      body.reasoning_effort = this.reasoningEffort;
    }
  }

  private serializeMessages(messages: Message[]): Message[] {
    return messages.map((message) => {
      const serialized: Message = { ...message };
      if (this.thinking !== "disabled" && serialized.role === "assistant" && serialized.tool_calls?.length && serialized.reasoning_content == null) {
        serialized.reasoning_content = "";
      }
      if (serialized.reasoning_content == null || this.thinking === "disabled") {
        delete serialized.reasoning_content;
      }
      return serialized;
    });
  }
}

function normalizeUsage(raw: any): Usage {
  if (!raw || typeof raw !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0 };
  }
  const usage: Usage = {
    prompt_tokens: Number(raw.prompt_tokens) || 0,
    completion_tokens: Number(raw.completion_tokens) || 0,
  };
  if (raw.prompt_cache_hit_tokens != null) usage.prompt_cache_hit_tokens = Number(raw.prompt_cache_hit_tokens) || 0;
  if (raw.prompt_cache_miss_tokens != null) usage.prompt_cache_miss_tokens = Number(raw.prompt_cache_miss_tokens) || 0;
  // Some providers nest cache info under prompt_tokens_details.cached_tokens.
  const cached = raw.prompt_tokens_details?.cached_tokens;
  if (usage.prompt_cache_hit_tokens == null && cached != null) {
    usage.prompt_cache_hit_tokens = Number(cached) || 0;
    usage.prompt_cache_miss_tokens = Math.max(0, usage.prompt_tokens - usage.prompt_cache_hit_tokens);
  }
  return usage;
}

function parseRemoteError(text: string): { type: string; message?: string } {  if (!text.trim()) return { type: "empty_response" };
  try {
    const data = JSON.parse(text) as any;
    const remote = data?.error ?? data;
    const type = String(remote?.type ?? remote?.code ?? remote?.status ?? "provider_error");
    const message = typeof remote?.message === "string" ? compact(safeErrorMessage(remote.message), 220) : undefined;
    return { type: compact(type, 80), message };
  } catch (err) {
    return { type: errorType(err) === "SyntaxError" ? "non_json_error_body" : "unparseable_error_body" };
  }
}
