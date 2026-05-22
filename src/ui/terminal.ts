import { EventEmitter } from "events";
import * as readline from "readline";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export interface RuntimeStatus {
  model: string;
  thinking: string;
  reasoning_effort: string;
}

export interface BannerStats {
  toolCount: number;
  mcpServerCount: number;
}

export function banner(runtime: RuntimeStatus, cwd: string, stats: BannerStats) {
  console.log(formatWhaleLogo());
  console.log(`${CYAN}${BOLD}+------------------------------------------------+${RESET}`);
  console.log(`${CYAN}${BOLD}|${RESET} ${MAGENTA}${BOLD}deepseek${RESET} ${BOLD}CLI${RESET}  ${DIM}Claude Code / Codex style${RESET}       ${CYAN}${BOLD}|${RESET}`);
  console.log(`${CYAN}${BOLD}|${RESET} model    ${GREEN}${pad(runtime.model, 36)}${RESET}${CYAN}${BOLD}|${RESET}`);
  console.log(`${CYAN}${BOLD}|${RESET} thinking ${YELLOW}${pad(formatThinking(runtime), 36)}${RESET}${CYAN}${BOLD}|${RESET}`);
  console.log(`${CYAN}${BOLD}|${RESET} cwd      ${DIM}${pad(shorten(cwd, 36), 36)}${RESET}${CYAN}${BOLD}|${RESET}`);
  console.log(`${CYAN}${BOLD}|${RESET} tools    ${YELLOW}${pad(`${stats.toolCount} total, ${stats.mcpServerCount} MCP`, 36)}${RESET}${CYAN}${BOLD}|${RESET}`);
  console.log(`${CYAN}${BOLD}+------------------------------------------------+${RESET}`);
  console.log(`${DIM}Type /help for commands, /status for runtime info, /exit to quit.${RESET}`);
  console.log();
}

function formatWhaleLogo(): string {
  return [
    `${CYAN}             .  .  .${RESET}          ${CYAN}${BOLD}DeepSeek CLI${RESET}`,
    `${CYAN}          .  :  :  .${RESET}       ${DIM}blue whale terminal agent${RESET}`,
    BLUE + "        .-\"\"\"\"\"\"-.        __" + RESET,
    BLUE + "  .----'   o   >_   `----._/ /" + RESET,
    BLUE + " /                         _ <" + RESET,
    BLUE + "|                         / `-._" + RESET,
    BLUE + " \\__                  __/      \\" + RESET,
    BLUE + "    `--.__________.--'       __/ " + RESET,
    CYAN + "          ~~~  ~~~  ~~~       \\__/" + RESET,
  ].join("\n");
}

const PROMPT_TEXT = "deepseek > ";
const PROMPT = `${GREEN}${PROMPT_TEXT}${RESET}`;

export interface TerminalReader {
  prompt(): void;
  close(): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

export function createRL(): TerminalReader {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.DEEPSEEK_LEGACY_READLINE === "1") {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
    }) as TerminalReader;
  }
  return new TerminalLineReader(process.stdin, process.stdout);
}

class TerminalLineReader extends EventEmitter implements TerminalReader {
  private chars: string[] = [];
  private cursor = 0;
  private active = false;
  private currentCursorRow = 0;
  private history: string[] = [];
  private historyIndex: number | null = null;
  private draft = "";
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly keypressHandler: (str: string | undefined, key: KeyInfo) => void;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    super();
    this.input = input;
    this.output = output;
    this.keypressHandler = (str, key) => this.handleKey(str, key);
    readline.emitKeypressEvents(this.input);
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("keypress", this.keypressHandler);
  }

  prompt(): void {
    this.active = true;
    this.render();
  }

  close(): void {
    this.input.off("keypress", this.keypressHandler);
    this.input.setRawMode?.(false);
    this.emit("close");
  }

  private handleKey(str: string | undefined, key: KeyInfo): void {
    if (!this.active) return;
    if (key.ctrl && key.name === "c") {
      this.output.write("\n");
      this.close();
      return;
    }
    if (key.ctrl && key.name === "d" && this.chars.length === 0) {
      this.output.write("\n");
      this.close();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.submitLine();
      return;
    }
    if (key.name === "backspace") {
      this.deleteBeforeCursor();
      return;
    }
    if (key.name === "delete" || (key.ctrl && key.name === "d")) {
      this.deleteAtCursor();
      return;
    }
    if (key.name === "left") {
      if (this.cursor > 0) this.cursor -= 1;
      this.render();
      return;
    }
    if (key.name === "right") {
      if (this.cursor < this.chars.length) this.cursor += 1;
      this.render();
      return;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.cursor = 0;
      this.render();
      return;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.cursor = this.chars.length;
      this.render();
      return;
    }
    if (key.name === "up") {
      if (!this.moveVertical(-1)) this.historyPrevious();
      this.render();
      return;
    }
    if (key.name === "down") {
      if (!this.moveVertical(1)) this.historyNext();
      this.render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      this.chars.splice(0, this.cursor);
      this.cursor = 0;
      this.resetHistoryNavigation();
      this.render();
      return;
    }
    if (key.ctrl && key.name === "k") {
      this.chars.splice(this.cursor);
      this.resetHistoryNavigation();
      this.render();
      return;
    }
    if (str && !key.ctrl && !key.meta && isPrintable(str)) {
      this.chars.splice(this.cursor, 0, ...Array.from(str));
      this.cursor += Array.from(str).length;
      this.resetHistoryNavigation();
      this.render();
    }
  }

  private submitLine(): void {
    const line = this.chars.join("");
    if (line && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = null;
    this.draft = "";
    this.active = false;
    this.currentCursorRow = 0;
    this.output.write("\n");
    this.emit("line", line);
  }

  private deleteBeforeCursor(): void {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.resetHistoryNavigation();
    this.render();
  }

  private deleteAtCursor(): void {
    if (this.cursor >= this.chars.length) return;
    this.chars.splice(this.cursor, 1);
    this.resetHistoryNavigation();
    this.render();
  }

  private historyPrevious(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.draft = this.chars.join("");
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    }
    this.setLine(this.history[this.historyIndex]);
  }

  private historyNext(): void {
    if (this.historyIndex === null) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.setLine(this.history[this.historyIndex]);
      return;
    }
    this.historyIndex = null;
    this.setLine(this.draft);
    this.draft = "";
  }

  private setLine(line: string): void {
    this.chars = Array.from(line);
    this.cursor = this.chars.length;
  }

  private resetHistoryNavigation(): void {
    this.historyIndex = null;
    this.draft = "";
  }

  private moveVertical(direction: -1 | 1): boolean {
    const positions = this.cursorPositions();
    const current = positions[this.cursor];
    const last = positions[positions.length - 1];
    const targetRow = current.row + direction;
    if (targetRow < 0 || targetRow > last.row) return false;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < positions.length; index++) {
      const position = positions[index];
      if (position.row !== targetRow) continue;
      const distance = Math.abs(position.col - current.col);
      if (distance < bestDistance || (distance === bestDistance && index > bestIndex)) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) return false;
    this.cursor = bestIndex;
    return true;
  }

  private render(): void {
    if (!this.active) return;
    readline.moveCursor(this.output, 0, -this.currentCursorRow);
    readline.cursorTo(this.output, 0);
    readline.clearScreenDown(this.output);

    const line = this.chars.join("");
    this.output.write(PROMPT + line);

    const columns = terminalColumns(this.output);
    const end = measureColumns(PROMPT_TEXT + line, columns);
    const desired = measureColumns(PROMPT_TEXT + this.chars.slice(0, this.cursor).join(""), columns);
    if (end.row > desired.row) {
      readline.moveCursor(this.output, 0, -(end.row - desired.row));
    }
    readline.cursorTo(this.output, desired.col);
    this.currentCursorRow = desired.row;
  }

  private cursorPositions(): CursorPosition[] {
    const columns = terminalColumns(this.output);
    const positions: CursorPosition[] = [];
    for (let index = 0; index <= this.chars.length; index++) {
      positions.push(measureColumns(PROMPT_TEXT + this.chars.slice(0, index).join(""), columns));
    }
    return positions;
  }
}

interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

interface CursorPosition {
  row: number;
  col: number;
}

function terminalColumns(output: NodeJS.WriteStream): number {
  return Math.max(20, output.columns || 80);
}

function measureColumns(value: string, columns: number): CursorPosition {
  let row = 0;
  let col = 0;
  for (const char of Array.from(value)) {
    if (char === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    const width = charWidth(char, col);
    if (width === 0) continue;
    if (col + width > columns) {
      row += 1;
      col = 0;
    }
    col += width;
    if (col >= columns) {
      row += 1;
      col = 0;
    }
  }
  return { row, col };
}

function charWidth(char: string, col: number): number {
  if (char === "	") return 4 - (col % 4);
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isCombiningMark(code)) return 0;
  return isFullWidthCodePoint(code) ? 2 : 1;
}

function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isFullWidthCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff))
  );
}

function isPrintable(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

export function printAssistant(text: string) {
  console.log(`\n${BOLD}DeepSeek${RESET}\n${text}\n`);
}

export function printInfo(text: string) {
  process.stderr.write(`${DIM}${text}${RESET}\n`);
}

export function printError(text: string) {
  process.stderr.write(`${RED}${text}${RESET}\n`);
}

export function printThinking(iteration: number) {
  process.stderr.write(`${DIM}thinking${iteration > 1 ? ` round ${iteration}` : ""}...${RESET}\n`);
}

export function printToolStart(name: string, args: Record<string, any>) {
  process.stderr.write(`${YELLOW}tool${RESET} ${name} ${DIM}${summarizeArgs(args)}${RESET}\n`);
}

export function printToolEnd(name: string, elapsedMs: number, error?: boolean) {
  const status = error ? `${RED}failed${RESET}` : `${GREEN}done${RESET}`;
  process.stderr.write(`${DIM}  ${name} ${status} in ${elapsedMs}ms${RESET}\n`);
}

export function printHelp() {
  console.log(`
${BOLD}DeepSeek CLI commands${RESET}
  /help                Show this help
  /status              Show model, thinking, cwd, tools, and MCP server counts
  /session             Save and show current session transcript path
  /compact [n]         Compact context, keeping n recent messages (default 12)
  /approvals           List pending shell approvals
  /approve <id>        Run a pending shell command
  /deny <id>           Reject a pending shell command
  /patches             List pending file patch previews
  /apply <id>          Apply a pending file patch
  /reject <id>         Reject a pending file patch
  /models              List model presets and compatibility aliases
  /model <name>         Switch model: pro, flash, chat, reasoner, or full model name
  /thinking <mode>      Switch thinking: auto, on, off, high, max
  /clear               Clear the terminal
  /exit                Quit

${BOLD}Line editing${RESET}
  Long wrapped input supports Left/Right, Home/End, Backspace/Delete, and Up/Down visual-row movement.
  At the top or bottom visual row, Up/Down navigates command history.

${BOLD}Non-interactive${RESET}
  deepseek --models
  deepseek --json --doctor
  deepseek --session work1 -t "start a task"
  deepseek --resume work1 -t "continue"
  deepseek --cwd path/to/repo -t "inspect this project"
  deepseek -t "summarize this repo"
  deepseek --model pro --thinking on -t "review this PR"
  deepseek --model flash --thinking off --doctor
`);
}

export function printStatus(runtime: RuntimeStatus, cwd: string, stats: BannerStats) {
  console.log(`
${BOLD}Status${RESET}
  model:            ${runtime.model}
  thinking:         ${runtime.thinking}
  reasoning_effort: ${runtime.reasoning_effort}
  cwd:              ${cwd}
  tools:            ${stats.toolCount}
  mcp:              ${stats.mcpServerCount} server(s)
`);
}

export function printRuntimeUpdated(runtime: RuntimeStatus) {
  console.log(`${DIM}runtime: ${runtime.model}, thinking=${runtime.thinking}, reasoning_effort=${runtime.reasoning_effort}${RESET}`);
}

function formatThinking(runtime: RuntimeStatus): string {
  return runtime.thinking === "enabled"
    ? `${runtime.thinking}, ${runtime.reasoning_effort}`
    : runtime.thinking;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function shorten(value: string, width: number): string {
  if (value.length <= width) return value;
  return `...${value.slice(value.length - width + 3)}`;
}

function summarizeArgs(args: Record<string, any>): string {
  const redacted = JSON.stringify(args, (key, value) => {
    if (/key|token|secret|password/i.test(key)) return "[redacted]";
    return value;
  });
  if (!redacted) return "";
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}
