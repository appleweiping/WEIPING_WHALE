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
const INVERSE = "\x1b[7m";

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
  console.log(`${DIM}Type / or \\ for the command palette, /help for commands, /exit to quit.${RESET}`);
  console.log();
}

function formatWhaleLogo(): string {
  return [
    `${BLUE}${BOLD}                 .-''''''-.        _.--.   ${RESET} ${CYAN}${BOLD}DeepSeek CLI${RESET}`,
    `${BLUE}${BOLD}             .-''  .--.   ''-.  .'  .-'   ${RESET} ${DIM}blue whale coding agent${RESET}`,
    `${CYAN}   .     .   ${BLUE}${BOLD}.'    .'${RESET}${BLUE}    '.     \/  .'      ${CYAN}.  .${RESET}`,
    `${CYAN} .   :   . ${BLUE}${BOLD}/     /${RESET}${BLUE}  .--.  \        /   _.--.  ${CYAN}:   .${RESET}`,
    `${CYAN}   . ' .  ${BLUE}${BOLD}|    |${RESET}${BLUE}  (    )  |      /_.-'  .'  ${CYAN}. ' .${RESET}`,
    `${BLUE}${BOLD}          |    |${RESET}${BLUE}   '--'   |          _.-'${RESET}     ${MAGENTA}${BOLD}\\/${RESET}`,
    `${BLUE}${BOLD}           \    \${RESET}${BLUE}        /      _..-'${RESET}      ${CYAN}\/ ${BLUE}${BOLD}/\${RESET}`,
    `${BLUE}${BOLD}            '.   '.___.'   _.-'${RESET}          ${CYAN}\___/${RESET}`,
    `${BLUE}${BOLD}              '-._______.-'${RESET}    ${CYAN}__..--${RESET}  ${BLUE}${BOLD}deepseek${RESET}`,
  ].join("\n");
}
const PROMPT_TEXT = "\u2501\u2501 ";
const PROMPT = `${BLUE}${BOLD}${PROMPT_TEXT}${RESET}`;
const MAX_MENU_ITEMS = 9;
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
const SHOW_CURSOR = "\x1b[?25h";

export interface SlashMenuContext {
  line: string;
  cursor: number;
}

export interface SlashMenuItem {
  label: string;
  description: string;
  replacement: string;
  submitOnAccept?: boolean;
  replaceStart?: number;
  replaceEnd?: number;
}

export interface SlashMenuResult {
  title: string;
  replaceStart: number;
  replaceEnd: number;
  items: SlashMenuItem[];
}

export type SlashMenuProvider = (context: SlashMenuContext) => SlashMenuResult | null;

export interface TerminalReader {
  prompt(): void;
  close(): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

export function createRL(slashMenuProvider?: SlashMenuProvider): TerminalReader {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.DEEPSEEK_LEGACY_READLINE === "1") {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
    }) as TerminalReader;
  }
  return new TerminalLineReader(process.stdin, process.stdout, slashMenuProvider);
}

export class TerminalLineReader extends EventEmitter implements TerminalReader {
  private chars: string[] = [];
  private cursor = 0;
  private active = false;
  private currentCursorRow = 0;
  private history: string[] = [];
  private historyIndex: number | null = null;
  private draft = "";
  private selectionAnchor: number | null = null;
  private slashMenu: SlashMenuResult | null = null;
  private slashIndex = 0;
  private mouseSelecting = false;
  private inputStartRow = 1;
  private pendingControlSequence = "";
  private slashMenuItemStartRow: number | null = null;
  private slashMenuMoreRow: number | null = null;
  private slashMenuEndRow: number | null = null;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly slashMenuProvider?: SlashMenuProvider;
  private readonly keypressHandler: (str: string | undefined, key: KeyInfo) => void;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream, slashMenuProvider?: SlashMenuProvider) {
    super();
    this.input = input;
    this.output = output;
    this.slashMenuProvider = slashMenuProvider;
    this.keypressHandler = (str, key) => this.handleKey(str, key);
    readline.emitKeypressEvents(this.input);
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("keypress", this.keypressHandler);
    this.output.write(SHOW_CURSOR + ENABLE_MOUSE_TRACKING);
  }

  prompt(): void {
    this.active = true;
    this.output.write(SHOW_CURSOR);
    this.refreshSlashMenu(false);
    this.render();
  }

  close(): void {
    this.input.off("keypress", this.keypressHandler);
    this.output.write(SHOW_CURSOR + DISABLE_MOUSE_TRACKING);
    this.input.setRawMode?.(false);
    this.emit("close");
  }

  debugState(): { line: string; cursor: number; selection: { start: number; end: number } | null; slashLabels: string[]; slashMenuItemStartRow: number | null; slashMenuMoreRow: number | null; inputStartRow: number } {
    return {
      line: this.chars.join(""),
      cursor: this.cursor,
      selection: this.selectionRange(),
      slashLabels: this.visibleSlashItems().map((item) => item.label),
      slashMenuItemStartRow: this.slashMenuItemStartRow,
      slashMenuMoreRow: this.slashMenuMoreRow,
      inputStartRow: this.inputStartRow,
    };
  }

  debugKey(str: string | undefined, key: KeyInfo = {}): void {
    this.handleKey(str, key);
  }

  private handleKey(str: string | undefined, key: KeyInfo): void {
    if (!this.active) return;
    const sequence = str ?? key.sequence ?? "";
    if (this.handleControlSequence(sequence, key)) return;
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
    if (key.name === "escape") {
      if (this.slashMenu || this.hasSelection()) {
        this.slashMenu = null;
        this.clearSelection();
        this.render();
      }
      return;
    }
    if (this.slashMenu && (key.name === "tab" || key.name === "return" || key.name === "enter")) {
      this.acceptSlashSelection();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.submitLine();
      return;
    }
    if (this.slashMenu && (key.name === "up" || (key.ctrl && key.name === "p"))) {
      this.slashIndex = Math.max(0, this.slashIndex - 1);
      this.render();
      return;
    }
    if (this.slashMenu && (key.name === "down" || (key.ctrl && key.name === "n"))) {
      this.slashIndex = Math.min(this.visibleSlashItems().length - 1, this.slashIndex + 1);
      this.render();
      return;
    }
    if (key.name === "backspace") {
      if (!this.deleteSelection()) this.deleteBeforeCursor();
      return;
    }
    if (key.name === "delete" || (key.ctrl && key.name === "d")) {
      if (!this.deleteSelection()) this.deleteAtCursor();
      return;
    }
    if (key.name === "left") {
      this.moveCursorTo(Math.max(0, this.cursor - 1), Boolean(key.shift));
      return;
    }
    if (key.name === "right") {
      this.moveCursorTo(Math.min(this.chars.length, this.cursor + 1), Boolean(key.shift));
      return;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.moveCursorTo(0, Boolean(key.shift));
      return;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.moveCursorTo(this.chars.length, Boolean(key.shift));
      return;
    }
    if (key.name === "up") {
      if (this.hasSelection()) this.clearSelection();
      if (!this.moveVertical(-1)) this.historyPrevious();
      this.refreshSlashMenu(true);
      this.render();
      return;
    }
    if (key.name === "down") {
      if (this.hasSelection()) this.clearSelection();
      if (!this.moveVertical(1)) this.historyNext();
      this.refreshSlashMenu(true);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      if (!this.deleteSelection()) {
        this.chars.splice(0, this.cursor);
        this.cursor = 0;
      }
      this.resetHistoryNavigation();
      this.refreshSlashMenu(false);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "k") {
      if (!this.deleteSelection()) this.chars.splice(this.cursor);
      this.resetHistoryNavigation();
      this.refreshSlashMenu(false);
      this.render();
      return;
    }
    if (str && !key.ctrl && !key.meta && isPlainTextInput(str) && isPrintable(str)) {
      this.insertText(str);
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
    this.selectionAnchor = null;
    this.slashMenu = null;
    this.slashIndex = 0;
    this.mouseSelecting = false;
    this.active = false;
    this.currentCursorRow = 0;
    this.output.write("\n");
    this.emit("line", line);
  }

  private insertText(value: string): void {
    this.deleteSelection();
    const chars = Array.from(value);
    this.chars.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    this.resetHistoryNavigation();
    this.refreshSlashMenu(false);
    this.render();
  }

  private deleteBeforeCursor(): void {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.resetHistoryNavigation();
    this.refreshSlashMenu(false);
    this.render();
  }

  private deleteAtCursor(): void {
    if (this.cursor >= this.chars.length) return;
    this.chars.splice(this.cursor, 1);
    this.resetHistoryNavigation();
    this.refreshSlashMenu(false);
    this.render();
  }

  private moveCursorTo(nextCursor: number, selecting: boolean): void {
    if (selecting) {
      if (this.selectionAnchor === null) this.selectionAnchor = this.cursor;
    } else {
      this.selectionAnchor = null;
    }
    this.cursor = nextCursor;
    this.refreshSlashMenu(true);
    this.render();
  }

  private hasSelection(): boolean {
    return this.selectionRange() !== null;
  }

  private clearSelection(): void {
    this.selectionAnchor = null;
  }

  private selectionRange(): { start: number; end: number } | null {
    if (this.selectionAnchor === null || this.selectionAnchor === this.cursor) return null;
    return {
      start: Math.min(this.selectionAnchor, this.cursor),
      end: Math.max(this.selectionAnchor, this.cursor),
    };
  }

  private deleteSelection(): boolean {
    const selection = this.selectionRange();
    if (!selection) return false;
    this.chars.splice(selection.start, selection.end - selection.start);
    this.cursor = selection.start;
    this.selectionAnchor = null;
    this.resetHistoryNavigation();
    this.refreshSlashMenu(false);
    this.render();
    return true;
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
    this.selectionAnchor = null;
  }

  private handleMouseSequence(sequence: string): boolean {
    if (!sequence.startsWith("\x1b")) return false;

    const sgrEvents = Array.from(sequence.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g));
    if (sgrEvents.length > 0) {
      const event = sgrEvents[sgrEvents.length - 1];
      this.applyMouseEvent(Number(event[1]), Number(event[2]), Number(event[3]), event[4] as "m" | "M", true);
      return true;
    }

    if (sequence.startsWith("\x1b[M") && sequence.length >= 6) {
      const code = sequence.charCodeAt(3) - 32;
      const x = sequence.charCodeAt(4) - 32;
      const y = sequence.charCodeAt(5) - 32;
      this.applyMouseEvent(code, x, y, "M", false);
      return true;
    }

    return true;
  }

  private handleControlSequence(sequence: string, key: KeyInfo): boolean {
    if (this.pendingControlSequence) {
      this.pendingControlSequence += sequence;
      if (this.tryHandlePendingControlSequence()) return true;
      if (this.pendingControlSequence.length > 64) this.pendingControlSequence = "";
      return true;
    }
    if (!sequence) return false;
    if (sequence === "\x1b" && !key.name) {
      this.pendingControlSequence = sequence;
      return true;
    }
    if (!key.name && sequence.startsWith("\x1b")) {
      if (this.isPartialMouseSequence(sequence)) {
        this.pendingControlSequence = sequence;
        return true;
      }
      return this.handleMouseSequence(sequence);
    }
    return false;
  }

  private tryHandlePendingControlSequence(): boolean {
    if (this.isPartialMouseSequence(this.pendingControlSequence)) return true;
    if (this.isCompleteMouseSequence(this.pendingControlSequence) && this.handleMouseSequence(this.pendingControlSequence)) {
      this.pendingControlSequence = "";
      return true;
    }
    if (this.pendingControlSequence.startsWith("\x1b")) {
      this.pendingControlSequence = "";
      return true;
    }
    return false;
  }

  private isPartialMouseSequence(sequence: string): boolean {
    return /^\x1b(?:\[|\[<|\[<\d+(?:;\d*){0,2})?$/.test(sequence);
  }

  private isCompleteMouseSequence(sequence: string): boolean {
    return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(sequence) || (sequence.startsWith("\x1b[M") && sequence.length >= 6);
  }

  private applyMouseEvent(code: number, x: number, y: number, suffix: "m" | "M", isSgr: boolean): void {
    if (suffix === "M" && this.isPrimaryMousePress(code)) {
      if (this.handleSlashMenuClick(y)) return;
    }
    const index = this.cursorIndexFromTerminalCell(x, y);
    if (index === null) return;
    if (suffix === "M" && (code & 32) === 0) {
      this.mouseSelecting = true;
      this.selectionAnchor = index;
      this.cursor = index;
    } else if (suffix === "M" && this.mouseSelecting && (code & 32) === 32) {
      this.cursor = index;
    } else if (suffix === "m") {
      if (this.mouseSelecting) this.cursor = index;
      this.mouseSelecting = false;
      if (this.selectionAnchor === this.cursor) this.selectionAnchor = null;
    } else if (!isSgr && this.mouseSelecting) {
      this.cursor = index;
    }
    this.refreshSlashMenu(true);
    this.render();
  }

  private isPrimaryMousePress(code: number): boolean {
    return (code & 32) === 0 && (code & 64) === 0 && (code & 3) === 0;
  }

  private handleSlashMenuClick(y: number): boolean {
    if (!this.slashMenu || this.slashMenuItemStartRow === null || this.slashMenuEndRow === null) return false;
    const targetRow = y - this.inputStartRow;
    if (targetRow < this.slashMenuItemStartRow || targetRow > this.slashMenuEndRow) return false;
    const index = targetRow - this.slashMenuItemStartRow;
    const items = this.visibleSlashItems();
    if (index >= 0 && index < items.length) {
      this.slashIndex = index;
      this.acceptSlashSelection();
      return true;
    }
    if (this.slashMenuMoreRow !== null && targetRow === this.slashMenuMoreRow) {
      return true;
    }
    return true;
  }

  private cursorIndexFromTerminalCell(x: number, y: number): number | null {
    const targetRow = y - this.inputStartRow;
    const targetCol = x - 1;
    if (targetRow < 0 || targetCol < 0) return null;
    const positions = this.cursorPositions();
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < positions.length; index++) {
      const position = positions[index];
      const rowDistance = Math.abs(position.row - targetRow);
      const colDistance = Math.abs(position.col - targetCol);
      const score = rowDistance * 1000 + colDistance;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
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

  private refreshSlashMenu(keepIndex: boolean): void {
    if (!this.slashMenuProvider || this.hasSelection()) {
      this.slashMenu = null;
      this.slashIndex = 0;
      return;
    }
    const menu = this.slashMenuProvider({ line: this.chars.join(""), cursor: this.cursor });
    this.slashMenu = menu && menu.items.length > 0 ? menu : null;
    if (!keepIndex || !this.slashMenu) this.slashIndex = 0;
    else this.slashIndex = Math.min(this.slashIndex, this.visibleSlashItems().length - 1);
  }

  private visibleSlashItems(): SlashMenuItem[] {
    return (this.slashMenu?.items ?? []).slice(0, MAX_MENU_ITEMS);
  }

  private acceptSlashSelection(): void {
    const menu = this.slashMenu;
    const item = this.visibleSlashItems()[this.slashIndex];
    if (!menu || !item) return;
    const replaceStart = item.replaceStart ?? menu.replaceStart;
    const replaceEnd = item.replaceEnd ?? menu.replaceEnd;
    const replacement = item.replacement;
    this.chars.splice(replaceStart, replaceEnd - replaceStart, ...Array.from(replacement));
    this.cursor = replaceStart + Array.from(replacement).length;
    this.clearSelection();
    this.resetHistoryNavigation();
    this.refreshSlashMenu(false);
    this.render();
    if (item.submitOnAccept) this.submitLine();
  }

  private render(): void {
    if (!this.active) return;
    readline.moveCursor(this.output, 0, -this.currentCursorRow);
    readline.cursorTo(this.output, 0);
    readline.clearScreenDown(this.output);

    const line = this.chars.join("");
    this.output.write(PROMPT + this.renderLineWithSelection(line));

    const columns = terminalColumns(this.output);
    const end = measureColumns(PROMPT_TEXT + line, columns);
    const footerRows = this.renderSlashMenu(columns, end.row);
    const desired = measureColumns(PROMPT_TEXT + this.chars.slice(0, this.cursor).join(""), columns);
    const renderedBottomRow = end.row + footerRows;
    this.inputStartRow = Math.max(1, (this.output.rows || 24) - renderedBottomRow);
    if (renderedBottomRow > desired.row) {
      readline.moveCursor(this.output, 0, -(renderedBottomRow - desired.row));
    }
    readline.cursorTo(this.output, desired.col);
    this.currentCursorRow = desired.row;
  }

  private renderLineWithSelection(line: string): string {
    const selection = this.selectionRange();
    if (!selection) return line;
    const chars = Array.from(line);
    let output = "";
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      output += index >= selection.start && index < selection.end ? `${INVERSE}${char}${RESET}` : char;
    }
    return output;
  }

  private renderSlashMenu(columns: number, inputEndRow: number): number {
    this.slashMenuItemStartRow = null;
    this.slashMenuMoreRow = null;
    this.slashMenuEndRow = null;
    if (!this.slashMenu) return 0;
    const items = this.visibleSlashItems();
    if (items.length === 0) return 0;
    const width = Math.min(Math.max(44, ...items.map((item) => stripAnsi(`${item.label} ${item.description}`).length + 6)), columns - 2);
    const lines = [`${DIM}${this.slashMenu.title}${RESET}`];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const selected = index === this.slashIndex;
      const prefix = selected ? `${BLUE}${BOLD}>${RESET}` : " ";
      const label = selected ? `${BOLD}${item.label}${RESET}` : item.label;
      const raw = `${prefix} ${label} ${DIM}${item.description}${RESET}`;
      lines.push(truncateDisplay(raw, width));
    }
    if ((this.slashMenu.items.length ?? 0) > items.length) {
      lines.push(`${DIM}    keep typing to filter ${this.slashMenu.items.length - items.length} more commands${RESET}`);
      this.slashMenuMoreRow = inputEndRow + 2 + items.length;
    }
    this.slashMenuItemStartRow = inputEndRow + 2;
    this.slashMenuEndRow = inputEndRow + lines.length;
    this.output.write("\n" + lines.join("\n"));
    return lines.length;
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

export interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
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
  if (char === "\t") return 4 - (col % 4);
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
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

function isPlainTextInput(value: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateDisplay(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  let visible = 0;
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\x1b") {
      const match = value.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        output += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    if (visible >= width - 1) break;
    output += value[index];
    visible += 1;
  }
  return output + `${DIM}?${RESET}`;
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
  /status              Show model, thinking, cwd, tools, safety, and MCP server counts
  /doctor              Run config, auth, safety, tool, and MCP diagnostics
  /tools               List built-in and MCP tools
  /mcp <cmd>           MCP status or reconnect: status, reconnect
  /sessions [n]        List recent saved sessions
  /memory <cmd>        Save session summary to agentmemory: save, status
  /retry               Retry the last user request after a network failure
  /permissions         Show permission, sandbox, and write-mode controls
  /approval <mode>     Set shell approvals: on-request, auto, never
  /sandbox <mode>      Set file-write sandbox: workspace-write, read-only, unrestricted
  /write-mode <mode>   Set file writes: preview, direct
  /session             Save and show current session transcript path
  /compact [n]         Compact context, keeping n recent messages (default 12)
  /approvals           List pending shell approvals
  /approve <id>        Run a pending shell command
  /deny <id>           Reject a pending shell command
  /patches             List pending file patch previews
  /apply <id>          Apply a pending file patch
  /reject <id>         Reject a pending file patch
  /models              List model presets and compatibility aliases
  /model <name>        Switch model: pro, flash, chat, reasoner, or full model name
  /thinking <mode>     Switch thinking: auto, on, off, high, max
  /clear               Clear the terminal
  /exit                Quit
  /quit                Quit

${BOLD}Command palette${RESET}
  Type / or \\ at the start of a whitespace-delimited token to open choices.
  The palette works mid-line, filters as you type, and opens nested choices for model, approval, sandbox, write-mode, and pending IDs.
  Use Up/Down to move, Tab or Enter to accept, Escape to dismiss.

${BOLD}Line editing${RESET}
  Long wrapped input supports Left/Right, Home/End, Backspace/Delete, and Up/Down visual-row movement.
  Hold Shift with Left/Right/Home/End to select text; Backspace/Delete replaces one-by-one deletion with one-shot selection deletion.
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

export function printStatus(runtime: RuntimeStatus, cwd: string, stats: BannerStats & { approvalMode?: string; sandboxMode?: string; writeMode?: string }) {
  console.log(`
${BOLD}Status${RESET}
  model:            ${runtime.model}
  thinking:         ${runtime.thinking}
  reasoning_effort: ${runtime.reasoning_effort}
  cwd:              ${cwd}
  tools:            ${stats.toolCount}
  mcp:              ${stats.mcpServerCount} server(s)
  approval_mode:    ${stats.approvalMode ?? "unknown"}
  sandbox_mode:     ${stats.sandboxMode ?? "unknown"}
  write_mode:       ${stats.writeMode ?? "unknown"}
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
