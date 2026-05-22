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
    `${BLUE}        ▄▄████▄▄${RESET}        ${CYAN}${BOLD}DeepSeek CLI${RESET}`,
    `${BLUE}    ▄██▓▓▓▓▓▓▓▓██▄${RESET}    ${DIM}blue whale terminal agent${RESET}`,
    `${BLUE}  ▄██▓▓  ▓▓▓▓  ▓▓██▄${RESET}  ${GREEN}>_${RESET}`,
    `${BLUE}  ██▓▓▓▓▓▓▓▓▓▓▓▓▓██▀${RESET}`,
    `${BLUE}   ▀██▓▓▓▓▓▓▓▓██▀  ▄${RESET}`,
    `${BLUE}      ▀▀████▀▀   ▀██▀${RESET}`,
  ].join("\n");
}

export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}deepseek >${RESET} `,
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
