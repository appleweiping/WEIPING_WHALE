<p align="center">
  <img src="https://raw.githubusercontent.com/appleweiping/DEEPSEEK_CLI/master/assets/banner.png" alt="DEEPSEEK_CLI" width="720" />
</p>

<p align="center">
  <strong>Terminal-native DeepSeek coding agent with honest diagnostics, safe patch previews, MCP, sessions, and agentmemory outbox support.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-cli-agent"><img src="https://img.shields.io/npm/v/deepseek-cli-agent?color=CB3837&label=npm&style=for-the-badge&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/appleweiping/DEEPSEEK_CLI/blob/master/LICENSE"><img src="https://img.shields.io/github/license/appleweiping/DEEPSEEK_CLI?color=blue&style=for-the-badge" alt="License" /></a>
</p>

DEEPSEEK_CLI is a focused coding-agent CLI for people who want a small terminal tool rather than a web app. It can inspect files, search with glob/grep, run shell commands behind approval gates, preview file edits as patches, connect MCP servers, resume saved sessions, and write compact session summaries to agentmemory when available.

The project goal is honesty over spectacle: `deepseek --doctor --json` reports exactly what is configured, what is missing, and where local state will be written without exposing API keys or raw provider URLs.

## Install

```bash
npm install -g deepseek-cli-agent
```

Or run from source:

```bash
git clone https://github.com/appleweiping/DEEPSEEK_CLI.git
cd DEEPSEEK_CLI
npm ci
npm run build
node dist/index.js --doctor
```

The 2026-06-04 upgrade pass ran Universal Upgrade Forge for 108 iterations and
materialized the public project identity as `DEEPSEEK_CLI`. See
[`docs/releases/2026-06-04-uupf-deepseek-cli-upgrade.md`](docs/releases/2026-06-04-uupf-deepseek-cli-upgrade.md).

## First Run

```bash
export DEEPSEEK_API_KEY="<your-key>"
deepseek --doctor
deepseek
```

Useful commands:

```bash
deepseek -t "summarize the architecture of this repo"
deepseek --model pro --thinking max -t "review this change for security and test gaps"
deepseek --model flash --thinking off -t "format these notes into markdown"
deepseek --models
deepseek --doctor --json
```

## What It Does

| Area | Behavior |
| --- | --- |
| Model runtime | DeepSeek V4 Pro/Flash presets, thinking controls, runtime switching tool |
| File work | `read_file`, `write_file`, `edit_file`, `glob`, `grep` |
| Shell work | `execute_bash` with blocked-command rules, approval queue, and bounded timeout |
| Patch safety | File writes default to preview; apply with `/apply <id>` |
| Sessions | `~/.deepseek-cli/sessions`, named sessions, resume, compact |
| Memory | agentmemory REST when reachable; local outbox when offline |
| MCP | stdio MCP servers become normal tools with diagnostics |
| Terminal UX | slash palette, nested command arguments, mouse support, wrapped-line editing |

## Safety Profiles

Use `/permission-model <mode>` or the equivalent environment variables.

| Profile | Writes | Sandbox | Shell |
| --- | --- | --- | --- |
| `safe` | preview | workspace only | ask for risky commands |
| `read-only` | blocked | read-only | ask for risky commands |
| `trusted` | direct | unrestricted | auto-run except blocked patterns |
| `locked` | preview | read-only | never run risky commands |

The default is `safe`. Broad destructive shell commands remain blocked even in permissive modes.

## Diagnostics

`deepseek --doctor --json` is designed for humans and CI:

```json
{
  "ok": true,
  "version": "0.2.0",
  "runtime": {
    "model": "deepseek-v4-flash",
    "thinking": "enabled",
    "reasoning_effort": "high"
  },
  "endpoint": {
    "configured": true,
    "host": "api.deepseek.com"
  },
  "auth": {
    "api_key": "configured",
    "source": "env"
  },
  "checks": []
}
```

The command exits non-zero when required checks fail. It does not print API keys, bearer tokens, or full provider URLs.

## Configuration

DeepSeek CLI loads the first config file found in this order:

1. `DEEPSEEK_CONFIG`
2. `./deepseek-cli.toml`
3. `./.deepseek-cli.toml`
4. `~/.deepseek-cli/config.toml`
5. packaged fallback `config.toml`

Example:

```toml
[llm]
model = "flash"
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"
temperature = 0.3
max_tokens = 4096
request_timeout_ms = 120000
thinking = "enabled"
reasoning_effort = "high"

[agent]
workspace = "."
max_iterations = 50
```

Environment overrides:

| Variable | Values |
| --- | --- |
| `DEEPSEEK_API_KEY` | provider API key |
| `DEEPSEEK_MODEL` | `pro`, `flash`, `chat`, `reasoner`, or a full model name |
| `DEEPSEEK_THINKING` | `auto`, `on`, `off`, `high`, `max` |
| `DEEPSEEK_REASONING_EFFORT` | `high`, `max` |
| `DEEPSEEK_BASE_URL` | OpenAI-compatible DeepSeek endpoint |
| `DEEPSEEK_APPROVAL_MODE` | `on-request`, `auto`, `never` |
| `DEEPSEEK_WRITE_MODE` | `preview`, `direct` |
| `DEEPSEEK_SANDBOX_MODE` | `workspace-write`, `read-only`, `unrestricted` |
| `AGENTMEMORY_URL` | active agentmemory endpoint |
| `DEEPSEEK_MEMORY_OUTBOX_DIR` | local memory outbox override |

## MCP

```toml
[mcp_servers.agentmemory]
command = "npx"
args = ["-y", "@agentmemory/mcp"]

[mcp_servers.agentmemory.env]
AGENTMEMORY_URL = "http://localhost:3111"
```

Run `/mcp status`, `/mcp reconnect`, or `deepseek --doctor --json` to inspect connection state. Failed MCP servers do not crash the CLI; they show safe error metadata.

## Relationship To The Other Vipin Tools

`WEIPING_COUNCIL` is the multi-model debate and orchestration layer. It benefits from richer provider health and cross-model review.

`deepseek-cli` is the lightweight terminal worker. It is best for fast local text/code tasks, patch previews, skill-guided maintenance, and inexpensive DeepSeek runs.

`WEIPING_LAB` is the experiment/workbench surface. DeepSeek CLI can help maintain it, but the lab remains the place where reproducible experiment workflows should be exposed.

The three projects should share operating discipline, not implementation bulk. This CLI intentionally keeps its core small and transparent.

## Design Notes

This release was shaped by reading concrete source modules from mature coding-agent CLIs instead of copying their surface marketing:

| Project | Source patterns inspected | Local adaptation |
| --- | --- | --- |
| Google Gemini CLI | `packages/cli/src/config/settings-validation.ts`, `packages/core/src/config/storage.ts`, `packages/core/src/utils/retry.ts`, `packages/core/src/utils/errorParsing.ts` | compact config checks, safe doctor report, bounded retry behavior |
| Aider | `aider/run_cmd.py`, `aider/models.py`, `tests/basic/test_run_cmd.py`, `tests/basic/test_models.py` | cross-platform shell output discipline, model preset clarity |
| OpenCode | `packages/opencode/src/config/config.ts`, `packages/opencode/src/util/error.ts`, `packages/opencode/src/session/message-error.ts`, `packages/opencode/src/provider/model-status.ts` | safe error metadata, explicit runtime status, CI release scan |

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for version history.

### 0.2.0 Upgrade Notes

- `deepseek --doctor --json` now returns a structured diagnostic object and exits non-zero when required checks fail.
- agentmemory is no longer mirrored into legacy markdown memory paths. Offline saves go to `~/.deepseek-cli/memory-outbox` or `DEEPSEEK_MEMORY_OUTBOX_DIR`.
- Provider and MCP errors are redacted by default. Use explicit debug flags only when you are comfortable with local diagnostic details.
- The packaged fallback config is public-safe and generic; personal/team operating rules belong in user or project config files.

### Known Limitations

- This package does not bundle a UI server; it is a terminal agent.
- E2E tests avoid real DeepSeek API calls. Provider availability is validated through config diagnostics, not live completions.
- Shell safety is pattern-based and conservative. Treat `trusted` mode as local full trust.
- MCP servers only receive explicitly configured env plus a minimal process environment.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` runs:

1. bundle build
2. no-network E2E CLI checks
3. package install smoke test
4. release scan for stale paths, secret-looking values, README/package mismatch, and outdated size claims

## Maintenance Skill

This repo includes `.codex/skills/deepseek-cli/SKILL.md`. Use it when planning, designing, developing, testing, releasing, maintaining, monitoring, and iterating this project. The skill requires:

- live source scan before claims
- concrete open-source code reference intake for non-trivial upgrades
- strict local verification
- post-batch multi-review scoring before commit
- commit and push after accepted changes

## License

MIT
