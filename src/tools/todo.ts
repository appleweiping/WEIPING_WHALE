/**
 * todo.ts — Persistent todo list for DeepSeek CLI
 *
 * Stores tasks in ~/.deepseek-cli/todos.json
 * Commands: /todo add <text> | /todo done <id> | /todo list | /todo clear | /todo remove <id>
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "done" | "in_progress";
  created: string;
  updated: string;
  priority: "high" | "normal" | "low";
}

const TODO_DIR = join(homedir(), ".deepseek-cli");
const TODO_FILE = join(TODO_DIR, "todos.json");

function ensureDir() {
  if (!existsSync(TODO_DIR)) mkdirSync(TODO_DIR, { recursive: true });
}

function loadTodos(): TodoItem[] {
  ensureDir();
  if (!existsSync(TODO_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TODO_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveTodos(todos: TodoItem[]) {
  ensureDir();
  writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2), "utf-8");
}

function newId(): string {
  return Math.random().toString(36).slice(2, 7);
}

export function todoAdd(text: string, priority: "high" | "normal" | "low" = "normal"): TodoItem {
  const todos = loadTodos();
  const item: TodoItem = {
    id: newId(),
    text: text.trim(),
    status: "pending",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    priority,
  };
  todos.push(item);
  saveTodos(todos);
  return item;
}

export function todoList(filter?: "pending" | "done" | "in_progress" | "all"): TodoItem[] {
  const todos = loadTodos();
  if (!filter || filter === "all") return todos;
  return todos.filter((t) => t.status === filter);
}

export function todoDone(id: string): TodoItem | null {
  const todos = loadTodos();
  const item = todos.find((t) => t.id === id || t.id.startsWith(id));
  if (!item) return null;
  item.status = "done";
  item.updated = new Date().toISOString();
  saveTodos(todos);
  return item;
}

export function todoStart(id: string): TodoItem | null {
  const todos = loadTodos();
  const item = todos.find((t) => t.id === id || t.id.startsWith(id));
  if (!item) return null;
  item.status = "in_progress";
  item.updated = new Date().toISOString();
  saveTodos(todos);
  return item;
}

export function todoRemove(id: string): boolean {
  const todos = loadTodos();
  const idx = todos.findIndex((t) => t.id === id || t.id.startsWith(id));
  if (idx === -1) return false;
  todos.splice(idx, 1);
  saveTodos(todos);
  return true;
}

export function todoClear(status?: "done" | "all"): number {
  const todos = loadTodos();
  const before = todos.length;
  const remaining = status === "all" ? [] : todos.filter((t) => t.status !== "done");
  saveTodos(remaining);
  return before - remaining.length;
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "  No tasks.";
  const STATUS_ICON: Record<string, string> = {
    pending: "○",
    in_progress: "◉",
    done: "✓",
  };
  const PRIORITY_COLOR: Record<string, string> = {
    high: "\x1b[31m",   // red
    normal: "\x1b[0m",
    low: "\x1b[2m",     // dim
  };
  const RESET = "\x1b[0m";
  return todos
    .map((t) => {
      const icon = STATUS_ICON[t.status] ?? "?";
      const color = PRIORITY_COLOR[t.priority] ?? "";
      const text = t.status === "done" ? `\x1b[2m${t.text}${RESET}` : `${color}${t.text}${RESET}`;
      return `  ${icon} \x1b[2m[${t.id}]\x1b[0m ${text}`;
    })
    .join("\n");
}

export function handleTodoCommand(arg: string): string {
  const parts = arg.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "list";
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "add":
    case "a": {
      if (!rest) return "Usage: /todo add <text> [--high|--low]";
      const priority = rest.includes("--high") ? "high" : rest.includes("--low") ? "low" : "normal";
      const text = rest.replace(/--high|--low/g, "").trim();
      const item = todoAdd(text, priority);
      return `  ○ [${item.id}] ${item.text}  (added)`;
    }
    case "done":
    case "d": {
      if (!rest) return "Usage: /todo done <id>";
      const item = todoDone(rest);
      return item ? `  ✓ [${item.id}] ${item.text}  (done)` : `  No task: ${rest}`;
    }
    case "start":
    case "s": {
      if (!rest) return "Usage: /todo start <id>";
      const item = todoStart(rest);
      return item ? `  ◉ [${item.id}] ${item.text}  (in progress)` : `  No task: ${rest}`;
    }
    case "remove":
    case "rm":
    case "r": {
      if (!rest) return "Usage: /todo remove <id>";
      return todoRemove(rest) ? `  Removed task ${rest}` : `  No task: ${rest}`;
    }
    case "clear": {
      const n = todoClear(rest === "all" ? "all" : "done");
      return `  Cleared ${n} task(s)`;
    }
    case "list":
    case "ls":
    case "": {
      const filter = (rest as any) || "all";
      const todos = todoList(filter === "all" ? "all" : filter);
      const pending = todos.filter((t) => t.status === "pending").length;
      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      const done = todos.filter((t) => t.status === "done").length;
      return `\nTodo  (${pending} pending · ${inProgress} in progress · ${done} done)\n${formatTodoList(todos)}\n`;
    }
    default:
      return "Usage: /todo <add|done|start|remove|clear|list> [args]";
  }
}
