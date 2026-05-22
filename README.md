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

- Branded startup panel with the blue pixel whale logo, model, current directory, built-in tool count, and MCP status
- One-line `deepseek >` prompt for interactive tasks
- Stable wrapped-line editing for long Chinese/English prompts, with Up/Down visual cursor movement and history at line boundaries
- Visible `thinking...` and per-tool progress lines while the agent works
- Slash commands: `/help`, `/status`, `/models`, `/model`, `/thinking`, `/approvals`, `/approve`, `/deny`, `/patches`, `/apply`, `/reject`, `/session`, `/compact`, `/clear`, `/exit`
- `--version`, `--doctor`, and `--json --doctor` for scriptable setup checks before a live model call
- `--models` for official model presets and compatibility aliases
- Approval/sandbox layer blocks dangerous shell commands and queues risky commands for `/approve`
- Patch preview mode queues file writes/edits for `/apply` instead of silently modifying files
- Session transcripts are saved under `~/.deepseek-cli/sessions/` and can be resumed with `--resume`
- GitHub Actions CI runs typecheck, build, and smoke E2E tests

In the local multi-agent setup, the file-based shared memory lives at `D:\research\Vipin's Knowledgebase\memory\`. MCP-based agentmemory can also be connected through the `mcp_servers` config when a running memory server is available.

## Features

### Built-in Tools

The agent autonomously decides when to use tools:

| Tool | Description |
|------|-------------|
| `execute_bash` | Run shell commands through the approval/safety gate |
| `read_file` | Read files with line numbers |
| `write_file` | Create patch previews for new or overwritten files |
| `edit_file` | Create patch previews for exact string replacements |
| `glob` | Find files by pattern |
| `grep` | Search content with regex (ripgrep) |

### MCP Integration

Connect any MCP-compatible server. The agent automatically discovers MCP tools, and `deepseek --doctor` reports configured servers plus connection diagnostics so agentmemory setups are easy to debug.

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

--- later, in Claude Code or Codex ---
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
| `DEEPSEEK_APPROVAL_MODE` | Shell approval mode: `on-request`, `never`, `auto` | `on-request` |
| `DEEPSEEK_WRITE_MODE` | File write mode: `preview`, `direct` | `preview` |
| `DEEPSEEK_SANDBOX_MODE` | File-write sandbox: `workspace-write`, `read-only`, `unrestricted` | `workspace-write` |

Config lookup order is `DEEPSEEK_CONFIG`, `deepseek-cli.toml` in the current directory, `.deepseek-cli.toml` in the current directory, `~/.deepseek-cli/config.toml`, then the packaged default config.


### Safety and Sessions

By default DeepSeek CLI behaves like a cautious coding agent rather than an unrestricted shell wrapper. Dangerous shell commands are blocked; risky commands create an approval item that can be reviewed with `/approvals`, run with `/approve <id>`, or denied with `/deny <id>`. File write tools create patch previews that can be reviewed with `/patches`, applied with `/apply <id>`, or rejected with `/reject <id>`. Patch application checks that the file has not changed since preview, and `workspace-write` sandbox mode blocks file writes outside the current workspace.

Set `DEEPSEEK_APPROVAL_MODE=auto`, `DEEPSEEK_WRITE_MODE=direct`, or `DEEPSEEK_SANDBOX_MODE=unrestricted` only in trusted automation. Sessions are persisted as JSON transcripts under `~/.deepseek-cli/sessions/`; use `--session <id>` to name one and `--resume <id>` to continue later. Use `/compact [n]` to summarize older context while keeping recent messages.


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
