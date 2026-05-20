import * as readline from "readline";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export function banner(model: string, cwd: string) {
  console.log(`${CYAN}${BOLD}╭─────────────────────────────────────────╮${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} ${BOLD}DeepSeek CLI${RESET} v0.1.0                     ${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} model: ${GREEN}${model}${RESET}${" ".repeat(Math.max(0, 32 - model.length))}${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}│${RESET} dir:   ${DIM}${cwd.slice(0, 32)}${RESET}${" ".repeat(Math.max(0, 32 - Math.min(cwd.length, 32)))}${CYAN}${BOLD}│${RESET}`);
  console.log(`${CYAN}${BOLD}╰─────────────────────────────────────────╯${RESET}`);
  console.log();
}

export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}› ${RESET}`,
  });
}

export function printAssistant(text: string) {
  console.log(`\n${text}\n`);
}

export function printInfo(text: string) {
  process.stderr.write(`${DIM}${text}${RESET}\n`);
}
