<p align="center">
  <img src="assets/banner.png" alt="DeepSeek CLI — Open-source AI in your terminal" width="720" />
</p>

<p align="center">
  <strong>Interactive terminal agent powered by DeepSeek. Native MCP support. Shared memory across agents.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-cli-agent"><img src="https://img.shields.io/npm/v/deepseek-cli-agent?color=CB3837&label=npm&style=for-the-badge&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/appleweiping/deepseek-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/appleweiping/deepseek-cli?color=blue&style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  <picture><img src="assets/tags/zero-sdk.svg" alt="Zero AI SDK deps" height="32" /></picture>
  <picture><img src="assets/tags/mcp-native.svg" alt="MCP Native" height="32" /></picture>
  <picture><img src="assets/tags/20kb.svg" alt="20KB bundle" height="32" /></picture>
</p>

---

## What is this?

DeepSeek CLI is an **interactive coding agent** that runs in your terminal — like Claude Code or Codex, but powered by DeepSeek models. It can read/write files, execute commands, search code, and connect to any MCP server (including shared memory systems like [agentmemory](https://github.com/rohitg00/agentmemory)).

## Works alongside

<table>
<tr>
<td align="center" width="20%">
<img src="https://upload.wikimedia.org/wikipedia/commons/e/ec/DeepSeek_logo.svg" alt="DeepSeek" width="48" height="48" /><br/>
<strong>DeepSeek</strong><br/>
<sub>V4 Pro / Flash / Chat</sub>
</td>
<td align="center" width="20%">
<img src="https://github.com/openai.png?size=120" alt="Codex" width="48" height="48" /><br/>
<strong>Codex CLI</strong><br/>
<sub>GPT-5.5</sub>
</td>
<td align="center" width="20%">
<img src="https://matthiasroder.com/content/images/2026/01/Claude.png?size=120" alt="Claude Code" width="48" height="48" /><br/>
<strong>Claude Code</strong><br/>
<sub>Opus / Sonnet</sub>
</td>
<td align="center" width="20%">
<img src="https://github.com/rohitg00/agentmemory/raw/main/assets/banner.png" alt="agentmemory" width="80" /><br/>
<strong>agentmemory</strong><br/>
<sub>Shared memory</sub>
</td>
</tr>
</table>

All agents share the same memory server — what one agent learns, all agents remember.

---

## Install

```bash
npm install -g deepseek-cli-agent
```

Or run directly:

```bash
npx deepseek-cli-agent
```

Or clone and build:

```bash
git clone https://github.com/appleweiping/deepseek-cli.git
cd deepseek-cli
npm install && npm run build
node dist/index.js
```

## Quick Start

```bash
# Set your API key
export DEEPSEEK_API_KEY="sk-..."

# Interactive mode
deepseek

# Inspect local setup without calling the model
deepseek --version
deepseek --doctor
deepseek --json --doctor

# List official presets and aliases
deepseek --models

# Single task
deepseek -t "refactor the auth module to use JWT"
deepseek "explain this repository"

# With a specific model and thinking mode
deepseek --model pro --thinking on -t "review this PR for security issues"
deepseek --model flash --thinking off -t "summarize these files"
deepseek --model=pro --thinking=max "debug the failing tests"

# Same controls through env
DEEPSEEK_MODEL=flash DEEPSEEK_THINKING=off deepseek -t "summarize this repo"

# Run against another working directory
deepseek --cwd path/to/repo -t "inspect this project"
```

## Terminal Experience

DeepSeek CLI is designed to feel like a small Claude Code / Codex-style terminal agent:

- Branded startup panel with model, current directory, built-in tool count, and MCP status
- One-line `deepseek >` prompt for interactive tasks
- Visible `thinking...` and per-tool progress lines while the agent works
- Slash commands: `/help`, `/status`, `/model`, `/thinking`, `/clear`, `/exit`
- `--version`, `--doctor`, and `--json --doctor` for scriptable setup checks before a live model call
- `--models` for official model presets and compatibility aliases

In the local multi-agent setup, the file-based shared memory lives at `D:\research\Vipin's Knowledgebase\memory\`. MCP-based agentmemory can also be connected through the `mcp_servers` config when a running memory server is available.

## Features

### Built-in Tools

The agent autonomously decides when to use tools:

| Tool | Description |
|------|-------------|
| `execute_bash` | Run shell commands |
| `read_file` | Read files with line numbers |
| `write_file` | Create or overwrite files |
| `edit_file` | Surgical string replacement |
| `glob` | Find files by pattern |
| `grep` | Search content with regex (ripgrep) |

### MCP Integration

Connect any MCP-compatible server. The agent automatically discovers and uses MCP tools.

```toml
# ~/.deepseek-cli/config.toml
[mcp_servers.agentmemory]
command = "npx"
args = ["-y", "@agentmemory/mcp"]

[mcp_servers.agentmemory.env]
AGENTMEMORY_URL = "http://localhost:3111"
```

### Multi-Agent Memory Sharing

When connected to [agentmemory](https://github.com/rohitg00/agentmemory), DeepSeek CLI shares persistent memory with Claude Code, Codex, OpenCode, and any other MCP-compatible agent:

```
You: remember that the auth service uses RS256 for JWT signing
DeepSeek: Saved to memory.

--- later, in Claude Code ---
You: what signing algorithm does auth use?
Claude: RS256 — I can see that from shared memory.
```

## Configuration

Create `~/.deepseek-cli/config.toml`:

```toml
[llm]
model = "deepseek-v4-flash"       # or deepseek-v4-pro
api_key_env = "DEEPSEEK_API_KEY"  # env var name containing the key
base_url = "https://api.deepseek.com"
temperature = 0.3
max_tokens = 4096
thinking = "enabled"              # auto/default, enabled, disabled
reasoning_effort = "high"         # high or max when thinking is enabled

[agent]
max_iterations = 50
workspace = "."

# Add any MCP server
[mcp_servers.my_server]
command = "node"
args = ["path/to/server.mjs"]

[mcp_servers.my_server.env]
SOME_VAR = "value"
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEEPSEEK_API_KEY` | API key (required) | - |
| `DEEPSEEK_MODEL` | Model name or alias: `pro`, `flash`, `chat`, `reasoner` | `deepseek-v4-flash` |
| `DEEPSEEK_THINKING` | Thinking mode: `auto`, `on`, `off`, `high`, `max` | `enabled` |
| `DEEPSEEK_REASONING_EFFORT` | Thinking effort: `high`, `max` | `high` |
| `DEEPSEEK_BASE_URL` | API endpoint | `https://api.deepseek.com` |
| `DEEPSEEK_CONFIG` | Explicit config file path | unset |

Config lookup order is `DEEPSEEK_CONFIG`, `deepseek-cli.toml` in the current directory, `.deepseek-cli.toml` in the current directory, `~/.deepseek-cli/config.toml`, then the packaged default config.


### JSON Output Policy

`--json` makes non-interactive commands return stable machine-readable output. Successful task runs use `{ "ok": true, "model": string, "thinking": string, "reasoning_effort": string, "output": string }`; CLI/setup errors use `{ "ok": false, "error": { "message": string } }`; `--json --doctor` redacts secrets and reports auth source only.

### Model and Thinking Modes

DeepSeek V4 exposes Pro and Flash variants in the public API. Both support thinking and non-thinking mode through the request-level `thinking` parameter. The official default is thinking enabled, and the CLI lets you combine model and thinking mode freely:

| CLI | Model | Thinking |
|-----|-------|----------|
| `--model pro --thinking on` | `deepseek-v4-pro` | enabled |
| `--model pro --thinking off` | `deepseek-v4-pro` | disabled |
| `--model flash --thinking on` | `deepseek-v4-flash` | enabled |
| `--model flash --thinking off` | `deepseek-v4-flash` | disabled |

Compatibility aliases are supported: `chat` maps to Flash non-thinking, and `reasoner` maps to Flash thinking. The legacy API names `deepseek-chat` and `deepseek-reasoner` are also normalized the same way.

Interactive switching is available without restarting:

```text
/model pro
/thinking max
/model flash
/thinking off
```

The agent can also switch autonomously with the built-in `configure_deepseek_runtime` tool when a task benefits from Pro or thinking mode, then switch back for routine work.

## Architecture

```
20KB single-file bundle, zero AI SDK dependencies

┌─────────────────────────────────────────────┐
│  Terminal UI (readline)                       │
├─────────────────────────────────────────────┤
│  Agent Loop (message → tool calls → repeat)  │
├──────────────────┬──────────────────────────┤
│  Built-in Tools  │  MCP Client (stdio)       │
│  • bash          │  • agentmemory            │
│  • file r/w/edit │  • any MCP server         │
│  • glob/grep     │                           │
├──────────────────┴──────────────────────────┤
│  DeepSeek API (OpenAI-compatible, native fetch) │
└─────────────────────────────────────────────┘
```

## Why?

- **DeepSeek is cheap and fast** — great for routine coding tasks, file operations, bulk edits
- **MCP makes it composable** — plug in memory, databases, APIs, other agents
- **20KB, 3 deps** — no bloated SDK, no framework lock-in, just fetch + tools
- **Multi-agent workflows** — use DeepSeek for grunt work, escalate to Claude/GPT for complex reasoning

## License

MIT
