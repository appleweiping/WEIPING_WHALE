# Usage reference

Everything here is also reachable from `/help` inside the REPL and from
`wwhale --help`.

## Command line

```bash
wwhale                                   # interactive REPL in the current directory
wwhale -t "summarize this repo"          # one task, print the answer, exit
wwhale --cwd path/to/repo                # work in another directory
wwhale --model auto                      # pick flash/pro per turn (see below)
wwhale --model pro --thinking max -t "review this change for security problems"
wwhale --session work1 -t "start a task" # named session
wwhale --resume work1                    # resume by id or unique prefix
wwhale --last                            # resume the most recent session
wwhale --doctor [--json]                 # config, auth source, paths, MCP state
wwhale --models                          # model presets and aliases
wwhale --serve --port 7878               # REPL plus the local HTTP/SSE API
```

## REPL commands

| Command | What it does |
| --- | --- |
| `/patches`, `/apply <id>`, `/reject <id>` | review and apply previewed edits |
| `/approvals`, `/approve <id>`, `/deny <id>` | shell commands waiting for approval |
| `/snapshots`, `/restore <id>`, `/undo` | side-git checkpoints of the workspace |
| `/fork`, `/backtrack [n]`, `/sessions` | branch or rewind the conversation |
| `/model <name>`, `/thinking <mode>` | switch model or thinking level |
| `/compact`, `/compact fast` | summarize old messages (model call or offline) |
| `/cost` | tokens, cache-hit ratio and estimated cost for this session |
| `/skills list`, `/skills install owner/repo` | manage `SKILL.md` skills |
| `/image <path>` | attach an image to the next message |
| `/handoff` | write `.weiping-whale/handoff.md` for the next session |
| `/permission-model <mode>` | `safe`, `read-only`, `trusted`, `locked` |

Typing `/` or `\` opens a filterable command palette.

## Safety profiles

| Profile | File writes | Write scope | Shell |
| --- | --- | --- | --- |
| `safe` (default) | preview, apply with `/apply` | workspace only | asks before risky commands |
| `read-only` | blocked | none | asks before risky commands |
| `trusted` | direct | anywhere | runs everything except blocked patterns |
| `locked` | preview | none | never runs risky commands |

A short list of destructive commands (for example `rm -rf .` or `git clean -fdx`)
stays blocked in every profile. Writes are checked for `..` escapes and for symlinks or junctions that point
outside the workspace. This is approval-gating and path checking, not an OS sandbox:
a command you approve runs with your user's permissions.

## Configuration files

The first file found wins:

1. `WEIPING_WHALE_CONFIG` or `DEEPSEEK_CONFIG` (explicit path)
2. `./weiping-whale.toml` or `./.weiping-whale.toml`, only in a trusted workspace
3. `./deepseek-cli.toml` or `./.deepseek-cli.toml`, only in a trusted workspace
4. `~/.weiping-whale/config.toml` (or the older `~/.deepseek-cli/config.toml`)
5. the packaged `config.toml`

```toml
[llm]
model = "flash"                 # flash, pro, auto, or a full model name
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"

[agent]
workspace = "."
max_iterations = 50             # model calls per turn before giving up

[snapshots]
enabled = true
retention_days = 7

[subagents]
max_agents = 4
max_depth = 2

[lsp]
enabled = true
include_warnings = false

[context]
repo_map_enabled = true
repo_map_max_chars = 12000
repo_map_max_files = 400

[pricing.deepseek-v4-flash]     # override the default prices in src/cost.ts
cache_hit_usd = 0.014
cache_miss_usd = 0.14
output_usd = 0.28

[mcp_servers.example]
command = "node"
args = ["server.mjs"]
timeout_ms = 60000
include_tools = ["search", "read"]   # optional allowlist
```

### Workspace trust

A `weiping-whale.toml` inside a repository can change `base_url` (where your API key
is sent) and start MCP processes, so it is ignored until you trust that exact
directory:

```bash
wwhale --cwd path/to/repo --trust-workspace --doctor
```

The decision is stored in `~/.weiping-whale/trusted-workspaces.json`.

## Model routing

`--model auto` (or `/model auto`) picks the model per turn from keywords in your
message, without an extra API call (`src/router.ts`): words like "debug", "error",
"refactor" or 调试 go to `pro` with maximum thinking, words like "search", "rename",
"format" go to `flash` with thinking off, and everything else gets `flash` with
thinking on.

## Repository map

At startup the agent lists git-tracked source files and extracts top-level symbols
for common languages (TypeScript/JavaScript, Python, Rust, Go, Java/Kotlin, C/C++, C#,
Ruby, PHP, Swift), ranked and cut to `repo_map_max_chars`. Ignored files, build output
and binaries are skipped. The prompt tells the model to open files before relying on
the map.

## Skills

A skill is a folder with a `SKILL.md` that has `name` and `description` in its YAML
front matter. They are discovered in `.weiping-whale/skills/` (workspace),
`~/.weiping-whale/skills/` (global), and also `.claude/skills` and `.agents/skills`.
`/skills install owner/repo` downloads one from GitHub.

## LSP diagnostics

After a direct write or `/apply`, the agent asks a language server for errors and
feeds them back to the model. Install the servers you want; missing ones are skipped.

```bash
npm install -g typescript-language-server typescript
npm install -g pyright
```

## HTTP/SSE API

`wwhale --serve` binds to `127.0.0.1` and prints a bearer token once:

```
GET  /health                       no auth
GET  /v1/cost                      session cost
POST /v1/message {"message":"…"}   run a turn, returns {"reply": "…"}
POST /v1/stream  {"message":"…"}   Server-Sent Events: start, reply, done
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"list the open TODOs"}' \
  http://127.0.0.1:7878/v1/message
```

API turns share one queue with the REPL. Binding to another host prints a warning:
anyone who can reach it and has the token can drive the agent.

## agentmemory (optional)

If you run an [agentmemory](https://github.com/rohitg00/agentmemory) server, set
`AGENTMEMORY_URL` (and `AGENTMEMORY_SECRET` if it needs one) and each turn's summary is
posted to it. When the server is unreachable the summary goes to
`~/.weiping-whale/memory-outbox/` instead. Without `AGENTMEMORY_URL` nothing is sent.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `DEEPSEEK_API_KEY` | API key (name configurable with `api_key_env`) |
| `DEEPSEEK_BASE_URL` | override `base_url` |
| `WEIPING_WHALE_HOME` | state directory instead of `~/.weiping-whale` |
| `WEIPING_WHALE_API_TOKEN` | fixed token for `--serve` |
| `DEEPSEEK_APPROVAL_MODE` | `on-request`, `auto`, `never` |
| `DEEPSEEK_SANDBOX_MODE` | `workspace-write`, `read-only`, `unrestricted` |
| `DEEPSEEK_WRITE_MODE` | `preview`, `direct` |
