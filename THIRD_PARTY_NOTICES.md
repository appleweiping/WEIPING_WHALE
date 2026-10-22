# Third-party notices

## CodeWhale

WEIPING_WHALE is a TypeScript port of the design of CodeWhale (formerly
`deepseek-tui`), <https://github.com/codewhale-hq/Codewhale>. The feature set, the
side-git snapshot scheme in `src/snapshot/`, the session fork/backtrack model, the
cost/cache footer, the auto-routing idea and the layered system prompt in
`prompts/base.md` follow CodeWhale's design. The code here was written in
TypeScript rather than copied from the Rust sources, but the port is close enough
that CodeWhale's license is reproduced below.

```
MIT License

Copyright (c) 2024-2025 DeepSeek-TUI Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

The npm dependencies listed in `package.json` (`@modelcontextprotocol/client`,
`@iarna/toml`, `fast-glob`, `js-yaml`, `vscode-jsonrpc`) are installed from npm
and keep their own licenses; none of their source is vendored in this repository.
