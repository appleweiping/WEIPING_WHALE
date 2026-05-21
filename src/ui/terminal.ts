import * as readline from "readline";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export interface BannerStats {
  toolCount: number;
  mcpServerCount: number;
}

export function banner(model: string, cwd: string, stats: BannerStats) {
  console.log(`${CYAN}${BOLD}╭────────────────────────────────────────────╮${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} ${MAGENTA}${BOLD}deepseek${RESET} ${BOLD}CLI${RESET}  ${DIM}Claude Code / Codex style${RESET} ${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} model ${GREEN}${pad(model, 35)}${RESET}${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} cwd   ${DIM}${pad(shorten(cwd, 35), 35)}${RESET}${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} tools ${YELLOW}${pad(`${stats.toolCount} total, ${stats.mcpServerCount} MCP`, 35)}${RESET}${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}╰────────────────────────────────────────────╯${RESET}`);
  console.log(`${DIM}Type /help for commands, /status for runtime info, /exit to quit.${RESET}`);
  console.log();
}

export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}deepseek ›${RESET} `,
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
  process.stderr.write(`${DIM}└─ ${name} ${status} in ${elapsedMs}ms${RESET}\n`);
}

export function printHelp() {
  console.log(`
${BOLD}DeepSeek CLI commands${RESET}
  /help       Show this help
  /status     Show model, cwd, tools, and MCP server counts
  /clear      Clear the terminal
  /exit       Quit

${BOLD}Non-interactive${RESET}
  deepseek -t "summarize this repo"
  deepseek --doctor
`);
}

export function printStatus(model: string, cwd: string, stats: BannerStats) {
  console.log(`
${BOLD}Status${RESET}
  model: ${model}
  cwd:   ${cwd}
  tools: ${stats.toolCount}
  mcp:   ${stats.mcpServerCount} server(s)
`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function shorten(value: string, width: number): string {
  if (value.length <= width) return value;
  return `…${value.slice(value.length - width + 1)}`;
}

function summarizeArgs(args: Record<string, any>): string {
  const redacted = JSON.stringify(args, (key, value) => {
    if (/key|token|secret|password/i.test(key)) return "[redacted]";
    return value;
  });
  if (!redacted) return "";
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}
