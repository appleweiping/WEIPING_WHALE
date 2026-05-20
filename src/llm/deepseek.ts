export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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

export interface CompletionResult {
  content: string | null;
  tool_calls: ToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

// PLACEHOLDER_STREAMING

export class DeepSeekClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private defaultTemp: number;
  private defaultMaxTokens: number;

  constructor(opts: {
    base_url: string;
    api_key: string;
    model: string;
    temperature: number;
    max_tokens: number;
  }) {
    this.baseUrl = opts.base_url.replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.model = opts.model;
    this.defaultTemp = opts.temperature;
    this.defaultMaxTokens = opts.max_tokens;
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    const body: any = {
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature ?? this.defaultTemp,
      max_tokens: opts.max_tokens ?? this.defaultMaxTokens,
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }

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
      throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = JSON.parse(text);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    return {
      content: choice.message?.content ?? null,
      tool_calls: choice.message?.tool_calls ?? [],
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    };
  }

  async *stream(opts: CompletionOptions): AsyncGenerator<string> {
    const body: any = {
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature ?? this.defaultTemp,
      max_tokens: opts.max_tokens ?? this.defaultMaxTokens,
      stream: true,
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 500)}`);
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
        const res = await fetch(url, init);
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        return res;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw new Error("Max retries exceeded");
  }
}
