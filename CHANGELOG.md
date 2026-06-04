# Changelog

## 0.2.0 - Honest Runtime Release

This release turns DeepSeek CLI from a useful local prototype into a more honest, release-gated terminal agent.

### Added

- Structured `deepseek --doctor --json` diagnostics with version, runtime, auth source, endpoint host, paths, safety modes, memory state, MCP state, tools, and config checks.
- Safe runtime helpers for redacting secret-looking text in errors.
- Local memory outbox under `~/.deepseek-cli/memory-outbox` or `DEEPSEEK_MEMORY_OUTBOX_DIR` when agentmemory is unavailable.
- Corrupt-session tolerance for session listing and resume checks.
- Release scan for stale local paths, secret-looking values, README/package mismatches, and package manifest expectations.
- Package install smoke test that packs the project, installs the tarball in a temp app, and runs the installed `deepseek` binary.
- Project maintenance skill at `.codex/skills/deepseek-cli/SKILL.md`.

### Changed

- Removed old Agent Hub mailbox and repo-local markdown memory assumptions.
- Packaged fallback config is now public-safe and generic.
- Provider and MCP errors are redacted by default.
- MCP subprocesses receive a minimal environment plus explicitly configured server env.
- `/monitor start` now respects shell risk classification and approval mode.
- README was rewritten around measurable behavior and current package size rather than stale bundle-size slogans.

### Verification

- `npm run typecheck`
- `npm test`
- `npm pack --dry-run`

### Known Limitations

- E2E tests do not make live DeepSeek API calls.
- Shell safety is pattern-based and should not be treated as a hardened OS sandbox.
- MCP server trust remains user-configured; only environment inheritance is minimized by default.

## 0.1.0

Initial public terminal-agent baseline.
