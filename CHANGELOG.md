# Changelog

## 0.5.0

- Removed the `deepseek` binary alias; the commands are `wwhale` and `weiping-whale`.
- Added `scripts/mock-deepseek.mjs`, a scripted stand-in for the DeepSeek API, plus
  `npm run demo` and an end-to-end test of the full agent loop that use it.
- Session autosave to an agentmemory server is now opt-in (`AGENTMEMORY_URL` or
  `DEEPSEEK_AGENTMEMORY=1`).
- Added `THIRD_PARTY_NOTICES.md` with CodeWhale's license; fixed the LICENSE holder.
- Moved the configuration reference to `docs/usage.md` and rewrote the README.
- Upgraded `@modelcontextprotocol/client` to 2.3.1 and `js-yaml` to 4.3.2 for
  security advisories.

## 0.4.1

- Install instructions describe the clone/build/link path, since the package is not
  on npm.
- CI actions pinned to commit SHAs; the package smoke test installs the tarball and
  runs every binary.

## 0.4.0

- Repository map: a size-limited list of tracked files and their top-level symbols
  goes into the system prompt.
- Workspace-local `weiping-whale.toml` is ignored until the directory is trusted with
  `--trust-workspace`, because it can change the API endpoint or start MCP servers.
- Switched to the official MCP TypeScript SDK client.
- Fixed workspace-write escapes through symlinks and Windows junctions.
- CI on Ubuntu and Windows.

## 0.3.0

Renamed from DEEPSEEK_CLI to WEIPING_WHALE and ported most of CodeWhale's feature set:
side-git snapshots with `/undo`, session fork/backtrack, the cost and cache-hit footer,
`/compact`, the layered system prompt, `--model auto` routing, skills, sub-agents,
LSP diagnostics after edits, image input and the optional `--serve` HTTP/SSE API.
State moved to `~/.weiping-whale` (an existing `~/.deepseek-cli` is still used).

## 0.2.0

- `--doctor --json` diagnostics.
- Secret redaction in error messages; MCP child processes get a minimal environment.
- Corrupt session files no longer break `/sessions` or `--resume`.

## 0.1.0

First terminal agent: DeepSeek chat loop with file, glob/grep and shell tools.
