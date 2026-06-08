/**
 * server/runtime-api.ts — optional local HTTP/SSE control surface for WEIPING_WHALE.
 *
 * SECURITY POSTURE (deliberate):
 *  - OFF by default; only starts when the user passes `--serve`.
 *  - Binds 127.0.0.1 only unless the user explicitly sets a host.
 *  - Requires a bearer token on every /v1 route; a token is auto-generated and
 *    printed once at startup if none is configured.
 *  - No file paths, secrets, or provider URLs are exposed in responses.
 *
 * Endpoints:
 *   GET  /health                      -> { ok, service, version }   (no auth)
 *   POST /v1/message  {message}       -> runs a turn, returns { reply }
 *   GET  /v1/stream?message=...       -> SSE: token/тool events then done
 *   GET  /v1/cost                     -> cost snapshot
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Agent } from "../agent.js";
import type { CostTracker } from "../cost.js";
import { VERSION } from "../runtime/version.js";

export interface RuntimeApiOptions {
  host?: string;
  port?: number;
  token?: string; // if omitted, one is generated
}

export interface RuntimeApiHandle {
  server: Server;
  url: string;
  token: string;
  close: () => Promise<void>;
}

export interface RuntimeApiDeps {
  agent: Agent;
  costTracker: CostTracker;
  // Serialize turns so concurrent requests don't interleave on one agent.
  runTurn: (message: string) => Promise<string>;
}

export function startRuntimeApi(deps: RuntimeApiDeps, opts: RuntimeApiOptions = {}): Promise<RuntimeApiHandle> {
  const host = opts.host || "127.0.0.1";
  const port = opts.port ?? 7878;
  const token = opts.token || randomBytes(24).toString("hex");

  const server = createServer((req, res) => {
    handle(req, res, deps, token).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolve({
        server,
        url,
        token,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: RuntimeApiDeps, token: string): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  // Health is unauthenticated and minimal.
  if (path === "/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, service: "weiping-whale", version: VERSION });
  }

  // Everything under /v1 requires a valid bearer token.
  if (path.startsWith("/v1")) {
    if (!checkAuth(req, token)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
  } else {
    return sendJson(res, 404, { error: "not found" });
  }

  if (path === "/v1/cost" && req.method === "GET") {
    return sendJson(res, 200, deps.costTracker.snapshot());
  }

  if (path === "/v1/message" && req.method === "POST") {
    const body = await readBody(req);
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) return sendJson(res, 400, { error: "message is required" });
    const reply = await deps.runTurn(message);
    return sendJson(res, 200, { reply });
  }

  if (path === "/v1/stream" && req.method === "GET") {
    const message = url.searchParams.get("message") || "";
    if (!message.trim()) return sendJson(res, 400, { error: "message query param is required" });
    return streamTurn(res, deps, message);
  }

  return sendJson(res, 404, { error: "not found" });
}

/** Constant-time bearer token check. */
function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

async function streamTurn(res: ServerResponse, deps: RuntimeApiDeps, message: string): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const sse = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Keep-alive ping so proxies don't drop the connection.
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  try {
    sse("start", { message });
    const reply = await deps.runTurn(message);
    sse("reply", { reply });
    sse("done", { ok: true });
  } catch (err: any) {
    sse("error", { error: String(err?.message ?? err) });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return resolve(null);
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}
