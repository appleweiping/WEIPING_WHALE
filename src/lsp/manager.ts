/**
 * lsp/manager.ts — post-edit LSP diagnostics for WEIPING_WHALE.
 *
 * Lazily spawns a language server per language (TypeScript, Python), opens the
 * edited file via LSP, waits briefly for publishDiagnostics, and returns a
 * compact diagnostics block to feed back into the model after an edit. Failure
 * (server missing, timeout) is silent — diagnostics are a best-effort aid, never
 * a blocker.
 */
import { spawn, type ChildProcess } from "child_process";
import { extname, join, delimiter, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";
import { existsSync, statSync, readFileSync } from "fs";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  line: number; // 1-based
  column: number; // 1-based
  severity: Severity;
  message: string;
}

interface LangServerSpec {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId: string;
}

// Language servers we support. Resolved lazily; absence is non-fatal.
const SERVERS: LangServerSpec[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: "typescript",
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageId: "python",
  },
];

const SEVERITY_MAP: Record<number, Severity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const MAX_LSP_FILE_BYTES = 2 * 1024 * 1024; // skip diagnostics for files larger than 2MB

interface LiveServer {
  proc: ChildProcess;
  conn: MessageConnection;
  initialized: Promise<void>;
  diagnostics: Map<string, Diagnostic[]>; // uri -> diags
  alive: boolean;
}

export interface LspOptions {
  enabled?: boolean;
  pollAfterEditMs?: number;
  includeWarnings?: boolean;
  maxPerFile?: number;
}

export class LspManager {
  private servers = new Map<string, LiveServer | null>(); // null = tried and unavailable
  private starting = new Map<string, Promise<LiveServer | null>>(); // in-flight startups
  private opts: Required<LspOptions>;
  private workspace: string;

  constructor(workspace: string, opts: LspOptions = {}) {
    this.workspace = workspace;
    this.opts = {
      enabled: opts.enabled ?? true,
      pollAfterEditMs: opts.pollAfterEditMs ?? 6000,
      includeWarnings: opts.includeWarnings ?? false,
      maxPerFile: opts.maxPerFile ?? 20,
    };
  }

  private specFor(file: string): LangServerSpec | undefined {
    const ext = extname(file).toLowerCase();
    return SERVERS.find((s) => s.extensions.includes(ext));
  }

  /** Get diagnostics for a file after an edit. Returns [] on any failure. */
  async diagnose(file: string): Promise<Diagnostic[]> {
    if (!this.opts.enabled) return [];
    const spec = this.specFor(file);
    if (!spec) return [];
    let server: LiveServer | null;
    try {
      server = await this.ensureServer(spec);
    } catch {
      return [];
    }
    if (!server) return [];

    const uri = pathToFileURL(file).toString();
    const key = canonicalUri(uri);
    // Size cap: skip very large files to avoid memory pressure and slow/hung
    // LSP notifications.
    try {
      if (statSync(file).size > MAX_LSP_FILE_BYTES) return [];
    } catch {
      return [];
    }
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return [];
    }
    // Skip apparently-binary content (NUL byte in the first chunk).
    if (text.length > 0 && text.indexOf("\0") !== -1) return [];

    server.diagnostics.delete(key);
    if (!isAlive(server)) return [];
    // didOpen triggers analysis; a follow-up didChange (after a short delay so
    // the server has loaded the project) nudges servers like
    // typescript-language-server that otherwise defer publishing.
    safeNotify(server, "textDocument/didOpen", {
      textDocument: { uri, languageId: spec.languageId, version: 1, text },
    });
    await delay(800);
    safeNotify(server, "textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text }],
    });

    // Poll for diagnostics. Servers often emit an empty batch first, then the
    // real diagnostics; keep waiting until we see a non-empty batch or a quiet
    // settle period elapses after the first publish, capped by the deadline.
    const deadline = Date.now() + this.opts.pollAfterEditMs;
    let firstPublishAt = 0;
    while (Date.now() < deadline) {
      const current = server.diagnostics.get(key);
      if (current !== undefined) {
        if (firstPublishAt === 0) firstPublishAt = Date.now();
        // Stop early once we have actual diagnostics.
        if (current.length > 0) {
          await delay(250); // settle for any follow-up batch
          break;
        }
        // Empty batch: keep waiting a bit longer for a non-empty follow-up.
        if (Date.now() - firstPublishAt > 1500) break;
      }
      await delay(120);
    }

    const collected = server.diagnostics.get(key) ?? [];
    const filtered = collected
      .filter((d) => this.opts.includeWarnings || d.severity === "error")
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .slice(0, this.opts.maxPerFile);

    // Close the doc to keep the server light. Best-effort; never let a write to
    // a closing/destroyed stream surface as an unhandled rejection.
    safeNotify(server, "textDocument/didClose", { textDocument: { uri } });
    return filtered;
  }

  private async ensureServer(spec: LangServerSpec): Promise<LiveServer | null> {
    if (this.servers.has(spec.id)) return this.servers.get(spec.id)!;
    // Memoize the in-flight startup so concurrent diagnose() calls for the same
    // language share ONE server (otherwise each would spawn an orphan).
    const pending = this.starting.get(spec.id);
    if (pending) return pending;
    const startPromise = this.startServer(spec).finally(() => this.starting.delete(spec.id));
    this.starting.set(spec.id, startPromise);
    return startPromise;
  }

  private async startServer(spec: LangServerSpec): Promise<LiveServer | null> {
    // SECURITY: resolve the language-server executable to a trusted ABSOLUTE path
    // via PATH, explicitly EXCLUDING the workspace, so a malicious workspace
    // cannot plant a same-named binary. We then spawn that absolute path. On
    // Windows the resolved path is a .cmd shim which requires a shell to run —
    // but since the path is absolute and already verified outside the workspace,
    // no further PATH resolution happens, so there is no hijack window.
    const exe = resolveExecutable(spec.command, this.workspace);
    if (!exe) {
      this.servers.set(spec.id, null);
      return null;
    }
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);

    let proc: ChildProcess;
    try {
      proc = spawn(needsShell ? `"${exe}"` : exe, spec.args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        shell: needsShell,
        windowsHide: true,
      });
    } catch {
      this.servers.set(spec.id, null);
      return null;
    }
    // If the binary is missing, spawn emits 'error' asynchronously.
    let spawnFailed = false;
    proc.on("error", () => {
      spawnFailed = true;
    });
    if (!proc.stdout || !proc.stdin) {
      this.servers.set(spec.id, null);
      return null;
    }

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    const diagnostics = new Map<string, Diagnostic[]>();
    conn.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const list: Diagnostic[] = (params?.diagnostics ?? []).map((d: any) => ({
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: SEVERITY_MAP[d.severity] ?? "info",
        message: String(d.message ?? "").slice(0, 500),
      }));
      diagnostics.set(canonicalUri(String(params?.uri ?? "")), list);
    });
    conn.onError(() => {});
    const live: LiveServer = { proc, conn, initialized: Promise.resolve(), diagnostics, alive: true };
    conn.onClose(() => {
      live.alive = false;
      this.servers.set(spec.id, null);
    });
    proc.on("exit", () => { live.alive = false; });
    conn.listen();

    const initialized = (async () => {
      await conn.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspace).toString(),
        capabilities: {
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
          },
        },
        workspaceFolders: [{ uri: pathToFileURL(this.workspace).toString(), name: "workspace" }],
      });
      conn.sendNotification("initialized", {});
    })();

    try {
      await Promise.race([initialized, delay(8000).then(() => Promise.reject(new Error("lsp init timeout")))]);
    } catch {
      try { proc.kill(); } catch { /* ignore */ }
      this.servers.set(spec.id, null);
      return null;
    }
    if (spawnFailed) {
      this.servers.set(spec.id, null);
      return null;
    }

    live.initialized = initialized;
    this.servers.set(spec.id, live);
    return live;
  }

  /** Shut down all language servers. */
  dispose(): void {
    for (const s of this.servers.values()) {
      if (!s) continue;
      s.alive = false;
      try { s.conn.dispose(); } catch { /* ignore */ }
      try { s.proc.kill(); } catch { /* ignore */ }
    }
    this.servers.clear();
  }
}

/** True if the server connection is still usable. */
function isAlive(server: LiveServer): boolean {
  return server.alive && !server.proc.killed;
}

/**
 * Resolve an executable to a trusted absolute path via PATH, EXCLUDING the
 * workspace (and any directory inside it). Returns null if not found. This
 * prevents a malicious workspace from planting a same-named binary that would
 * run when diagnostics fire. On Windows, tries PATHEXT extensions.
 */
function resolveExecutable(command: string, workspace: string): string | null {
  const wsReal = (() => {
    try { return resolvePath(workspace).toLowerCase(); } catch { return resolvePath(workspace); }
  })();
  const isInsideWorkspace = (p: string) => {
    const rp = resolvePath(p).toLowerCase();
    return rp === wsReal || rp.startsWith(wsReal + (process.platform === "win32" ? "\\" : "/"));
  };
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    // Skip any PATH entry that lives inside the workspace.
    if (isInsideWorkspace(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Send a notification without ever surfacing an error — neither the synchronous
 * throw nor the async write rejection (vscode-jsonrpc resolves the write on a
 * later tick, so a destroyed stream would otherwise become an unhandled rejection).
 */
function safeNotify(server: LiveServer, method: string, params: unknown): void {
  if (!isAlive(server)) return;
  try {
    const p = server.conn.sendNotification(method as any, params as any);
    if (p && typeof (p as Promise<void>).then === "function") {
      (p as Promise<void>).then(undefined, () => {});
    }
  } catch {
    // ignore
  }
}

/** Render diagnostics as a compact block for the model. */
export function renderDiagnostics(file: string, diags: Diagnostic[]): string | undefined {
  if (diags.length === 0) return undefined;
  // Escape file path and messages: LSP output is UNTRUSTED (a hostile file path
  // or diagnostic text could otherwise inject a closing tag + fake model-facing
  // instructions). Strip control chars and neutralize angle brackets.
  const esc = (s: string) =>
    s.replace(/[\u0000-\u001f]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = diags.map((d) => `  ${d.severity.toUpperCase()} [${d.line}:${d.column}] ${esc(d.message)}`);
  return `<diagnostics file="${esc(file)}" note="untrusted tool output">\n${lines.join("\n")}\n</diagnostics>`;
}

function severityRank(s: Severity): number {
  return { error: 0, warning: 1, info: 2, hint: 3 }[s];
}

/** Canonicalize a file URI for cross-platform comparison (Windows drive case,
 *  %3A vs : encoding, trailing slash). */
function canonicalUri(uri: string): string {
  try {
    let u = decodeURIComponent(uri);
    u = u.replace(/^file:\/\//i, "");
    u = u.replace(/^\/+/, "");
    u = u.replace(/\\/g, "/").toLowerCase();
    return u;
  } catch {
    return uri.toLowerCase();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
