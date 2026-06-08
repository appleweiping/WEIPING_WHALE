import assert from "node:assert/strict";

// Verify the agent builds OpenAI-compatible image_url content blocks when images
// are attached, without making a network call. We stub the DeepSeek client by
// intercepting the messages the agent assembles.

const { Agent } = await import("../src/agent.ts");

// Minimal config + mcp stubs.
const config = {
  llm: { model: "deepseek-v4-flash", api_key: "x", base_url: "https://api.deepseek.com", temperature: 0.3, max_tokens: 100, request_timeout_ms: 1000, thinking: "disabled", reasoning_effort: "high" },
  agent: { max_iterations: 1, workspace: ".", system_prompt: "test" },
  mcp_servers: {},
};
const mcp = { getToolDefs: () => [], callTool: async () => null, getServerCount: () => 0 };

const agent = new Agent(config, mcp);

// Reach into the agent: push a turn with an image, then inspect getMessages().
// We call run() but short-circuit the network by replacing the client.complete.
agent.client = { // @ts-ignore - test stub
  complete: async () => ({ content: "ok", reasoning_content: null, tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  getModel: () => "deepseek-v4-flash",
  getThinking: () => ({ mode: "disabled", effort: "high" }),
  setModel() {}, setThinking() {},
};

const img = { path: "x.png", base64: "QUJD", mimeType: "image/png" };
await agent.run("describe this image", {}, [img]);

const msgs = agent.getMessages();
const userMsg = msgs.find((m) => m.role === "user");
assert.ok(userMsg, "user message present");
assert.ok(Array.isArray(userMsg.content), "content is a block array when image attached");
const blocks = userMsg.content;
assert.equal(blocks[0].type, "text", "first block is text");
assert.equal(blocks[0].text, "describe this image", "text preserved");
assert.equal(blocks[1].type, "image_url", "second block is image_url");
assert.match(blocks[1].image_url.url, /^data:image\/png;base64,QUJD$/, "data URL well-formed");

// getLastUserMessage flattens blocks to text for routing/memory.
assert.match(agent.getLastUserMessage(), /describe this image/, "last user message flattened");

// No-image path stays a plain string.
const agent2 = new Agent(config, mcp);
agent2.client = { complete: async () => ({ content: "ok", reasoning_content: null, tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), getModel: () => "deepseek-v4-flash", getThinking: () => ({ mode: "disabled", effort: "high" }), setModel() {}, setThinking() {} };
await agent2.run("plain text", {});
const u2 = agent2.getMessages().find((m) => m.role === "user");
assert.equal(typeof u2.content, "string", "no-image turn stays string content");

console.log("vision e2e ok");
