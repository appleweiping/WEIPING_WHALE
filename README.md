<p align="center">
  <img src="assets/banner.png" alt="DeepSeek CLI" width="720" />
</p>

<p align="center">
  <strong>Terminal-native coding agent powered by DeepSeek V4.</strong>
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

## Overview

DeepSeek CLI is an interactive coding agent that runs in your terminal. It reads and writes files, executes shell commands, searches codebases, and connects to external tools via MCP — all driven by DeepSeek V4 Pro and Flash models.

20KB single-file bundle. Three runtime dependencies. No AI SDK.

---

## Install

```bash
npm install -g deepseek-cli-agent
```

Or run without installing:

```bash
npx deepseek-cli-agent
```

Or build from source:

```bash
git clone https://github.com/appleweiping/deepseek-cli.git
cd deepseek-cli && npm install && npm run build
node dist/index.js
```

---

## Usage

```bash
# Set API key
export DEEPSEEK_API_KEY="sk-..."

# Interactive session
deepseek

# Single task
deepseek -t "refactor the auth module to use JWT"

# Model and thinking control
deepseek --model pro --thinking max -t "review this PR for security issues"
deepseek --model flash --thinking off -t "summarize these files"

# Diagnostics (no API call)
deepseek --doctor
deepseek --models
```

---

## Features

### Built-in Tools

| Tool | Description |
|------|-------------|
| `execute_bash` | Shell execution with approval gate |
| `read_file` | Read files with line numbers |
| `write_file` | Create or overwrite files (patch preview in safe mode) |
| `edit_file` | Exact string replacement (patch preview in safe mode) |
| `glob` | Find files by pattern |
| `grep` | Regex content search (ripgrep) |

### Terminal Editor

- Wrapped-line editing with visual Up/Down cursor movement
- Shift-selection, mouse drag selection, one-shot deletion of selected text
- Command history navigation at line boundaries
- Slash command palette with scrollable menu, mouse click support, and nested argument selection

### Command Palette

Type `/` or `\` at any whitespace boundary to open the palette. Supports filtering, keyboard navigation (Up/Down/PageUp/PageDown), mouse wheel scrolling, and click-to-select.

Commands: `/help` `/status` `/doctor` `/tools` `/mcp` `/sessions` `/memory` `/retry` `/permissions` `/permission-model` `/approval` `/sandbox` `/write-mode` `/models` `/model` `/thinking` `/session` `/compact` `/approvals` `/approve` `/deny` `/patches` `/apply` `/reject` `/clear` `/exit`

### Safety Model

Four bundled permission profiles control shell execution, file writes, and sandbox scope:

| Profile | Writes | Sandbox | Shell Approval |
|---------|--------|---------|----------------|
| `safe` | preview | workspace | on-request |
| `read-only` | blocked | read-only | on-request |
| `trusted` | direct | unrestricted | auto |
| `locked` | preview | read-only | never |

Risky shell commands are queued for review (`/approvals` → `/approve <id>`). File edits create patch previews (`/patches` → `/apply <id>`).

### MCP Integration

Connect any MCP-compatible server. The agent discovers tools at startup and exposes them alongside built-in tools.

```toml
# ~/.deepseek-cli/config.toml
[mcp_servers.agentmemory]
command = "npx"
args = ["-y", "@agentmemory/mcp"]

[mcp_servers.agentmemory.env]
AGENTMEMORY_URL = "http://localhost:3111"
```

`deepseek --doctor` reports MCP connection status and diagnostics.

### Sessions

Transcripts are persisted under `~/.deepseek-cli/sessions/`. Name a session with `--session <id>`, resume with `--resume <id>`. Network failures auto-save the transcript. Use `/compact [n]` to summarize older context.

---

## Configuration

```toml
# ~/.deepseek-cli/config.toml
[llm]
model = "deepseek-v4-flash"
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"
temperature = 0.3
max_tokens = 4096
thinking = "enabled"
reasoning_effort = "high"

[agent]
max_iterations = 50
workspace = "."
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEEPSEEK_API_KEY` | API key (required) | — |
| `DEEPSEEK_MODEL` | `pro`, `flash`, `chat`, `reasoner`, or full model name | `deepseek-v4-flash` |
| `DEEPSEEK_THINKING` | `auto`, `on`, `off`, `high`, `max` | `enabled` |
| `DEEPSEEK_BASE_URL` | API endpoint | `https://api.deepseek.com` |
| `DEEPSEEK_APPROVAL_MODE` | `on-request`, `auto`, `never` | `on-request` |
| `DEEPSEEK_WRITE_MODE` | `preview`, `direct` | `preview` |
| `DEEPSEEK_SANDBOX_MODE` | `workspace-write`, `read-only`, `unrestricted` | `workspace-write` |

### Model Presets

| Preset | Model | Thinking |
|--------|-------|----------|
| `pro` | deepseek-v4-pro | enabled |
| `flash` | deepseek-v4-flash | enabled |
| `chat` | deepseek-v4-flash | disabled |
| `reasoner` | deepseek-v4-flash | enabled |

Switch at runtime with `/model <preset>` and `/thinking <mode>`.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Terminal UI                                  │
│  • Raw data mouse interception               │
│  • Scrollable command palette                │
│  • Wrapped-line editor with selection        │
├─────────────────────────────────────────────┤
│  Agent Loop                                  │
│  • Message → tool calls → repeat            │
│  • Auto model/thinking switching             │
├──────────────────┬──────────────────────────┤
│  Built-in Tools  │  MCP Client (stdio)       │
│  • bash          │  • Any MCP server         │
│  • file r/w/edit │  • agentmemory            │
│  • glob / grep   │  • Custom tools           │
├──────────────────┴──────────────────────────┤
│  DeepSeek API (OpenAI-compatible, native fetch) │
└─────────────────────────────────────────────┘
```

20KB bundle. Zero AI SDK dependencies. Three runtime deps: `fast-xml-parser`, `fastq`, `toml`.

---

## License

MIT
