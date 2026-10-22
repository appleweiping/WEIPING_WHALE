// A tiny stand-in for the DeepSeek chat-completions endpoint.
//
// It speaks just enough of the OpenAI-compatible API for WEIPING_WHALE's agent
// loop (POST /chat/completions, non-streaming, with tool calls). Instead of a
// language model it runs a scripted policy that looks at the conversation and
// decides the next tool call. The tool *results* are real: the CLI actually
// runs the shell command, reads the file and builds the patch, and the script
// quotes those results back. That makes it useful for two things:
//
//   * tests of the whole loop (scripts/e2e-agent-loop.mjs) without network,
//   * a demo you can run without an API key (npm run demo).
//
// Run it standalone with `node scripts/mock-deepseek.mjs [port]` and point the
// CLI at it with DEEPSEEK_BASE_URL=http://127.0.0.1:<port>.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * Scripted "model" for the slugify demo workspace (see scripts/demo.mjs).
 * Returns the assistant message for the next step of the current user turn.
 */
export function slugifyScenario(messages) {
  const lastUser = findLastIndex(messages, (m) => m.role === "user");
  const userText = textOf(messages[lastUser]?.content).toLowerCase();
  const turn = messages.slice(lastUser + 1);
  const toolResults = turn.filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const step = turn.filter((m) => m.role === "assistant").length;

  if (/fail|bug|fix/.test(userText)) {
    if (step === 0) return toolCall("execute_bash", { command: "node test.mjs" });
    if (step === 1) return toolCall("read_file", { path: "src/slugify.mjs" });
    if (step === 2) {
      return toolCall("edit_file", {
        path: "src/slugify.mjs",
        old_string: '    .replace(/[^a-z0-9]+/g, "-");',
        new_string: '    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");',
      });
    }
    const actual = toolResults[0]?.match(/actual: '([^']*)'/)?.[1];
    const patchId = toolResults[2]?.match(/Patch preview created: (\S+)/)?.[1] ?? "(see /patches)";
    return text(
      [
        actual
          ? `\`node test.mjs\` fails because slugify("Hello, World!") returns "${actual}".`
          : "`node test.mjs` fails on the first assertion.",
        "The regex turns every run of non-alphanumerics into a dash, including the",
        "trailing \"!\", and nothing trims dashes at the ends.",
        "",
        `I prepared patch ${patchId}, which strips leading and trailing dashes.`,
        `Review it with /patches, then /apply ${patchId}.`,
      ].join("\n"),
    );
  }

  if (/test|again|re-?run/.test(userText)) {
    if (step === 0) return toolCall("execute_bash", { command: "node test.mjs" });
    const output = (toolResults[0] ?? "").trim().split("\n")[0];
    return text(`Ran \`node test.mjs\`: ${output}`);
  }

  return text("This is the scripted mock model. Try: \"test.mjs fails, find the bug and fix it\".");
}

/**
 * Start the mock server. `policy(messages)` returns the next assistant message.
 * Resolves to { url, requests, close }.
 */
export function startMockDeepSeek({ port = 0, policy = slugifyScenario } = {}) {
  const requests = [];
  let previousPrompt = "";
  let callCount = 0;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: "mock only serves /chat/completions" } }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_json" } }));
        return;
      }
      requests.push(request);
      const message = policy(request.messages ?? []);

      // Rough token accounting (4 chars per token) so the cost footer has
      // something to show. Cache hits are the prefix shared with the previous
      // request, which is how DeepSeek's prefix cache behaves.
      const prompt = JSON.stringify(request.messages ?? []);
      const shared = commonPrefixLength(prompt, previousPrompt);
      previousPrompt = prompt;
      const promptTokens = Math.ceil(prompt.length / 4);
      const hitTokens = Math.floor(shared / 4);
      const completionTokens = Math.ceil(JSON.stringify(message).length / 4);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `mock-${++callCount}`,
          object: "chat.completion",
          model: request.model,
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            prompt_cache_hit_tokens: hitTokens,
            prompt_cache_miss_tokens: promptTokens - hitTokens,
          },
        }),
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function toolCall(name, args) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function text(content) {
  return { role: "assistant", content };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => block.text ?? "").join(" ");
  return "";
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) if (predicate(items[index])) return index;
  return -1;
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.argv[2] ?? 7979);
  const mock = await startMockDeepSeek({ port });
  console.log(`mock DeepSeek endpoint on ${mock.url} (scripted, no real model)`);
  console.log(`try: DEEPSEEK_API_KEY=mock DEEPSEEK_BASE_URL=${mock.url} wwhale --cwd <demo workspace>`);
}
