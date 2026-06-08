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

const MAX_MESSAGE_CHARS = 100_000;
const MAX_IN_FLIGHT_TURNS = 4;
const MAX_SSE_CONNECTIONS = 8;

/** Per-server runtime limits + counters. */
interface ApiState {
  inFlight: number;
  sseCount: number;
  tryAcquire: () => boolean;
  release: () => void;
}

export function startRuntimeApi(deps: RuntimeApiDeps, opts: RuntimeApiOptions = {}): Promise<RuntimeApiHandle> {
  const host = opts.host || "127.0.0.1";
  const port = opts.port ?? 7878;
  const token = opts.token || randomBytes(24).toString("hex");

  const state: ApiState = {
    inFlight: 0,
    sseCount: 0,
    tryAcquire() {
      if (this.inFlight >= MAX_IN_FLIGHT_TURNS) return false;
      this.inFlight += 1;
      return true;
    },
    release() {
      this.inFlight = Math.max(0, this.inFlight - 1);
    },
  };

  const server = createServer((req, res) => {
    handle(req, res, deps, token, state).catch(() => {
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

async function handle(req: IncomingMessage, res: ServerResponse, deps: RuntimeApiDeps, token: string, state: ApiState): Promise<void> {
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
    if (body === null) return sendJson(res, 413, { error: "request body invalid or too large" });
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) return sendJson(res, 400, { error: "message is required" });
    if (!state.tryAcquire()) return sendJson(res, 429, { error: "too many in-flight turns" });
    try {
      const reply = await deps.runTurn(message.slice(0, MAX_MESSAGE_CHARS));
      return sendJson(res, 200, { reply });
    } finally {
      state.release();
    }
  }

  // Stream a turn over SSE. The prompt is in the POST body (NOT the URL) so it
  // never lands in access logs / shell history.
  if (path === "/v1/stream" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, { error: "request body invalid or too large" });
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) return sendJson(res, 400, { error: "message is required" });
    if (state.sseCount >= MAX_SSE_CONNECTIONS) return sendJson(res, 429, { error: "too many open streams" });
    if (!state.tryAcquire()) return sendJson(res, 429, { error: "too many in-flight turns" });
    return streamTurn(res, req, deps, message.slice(0, MAX_MESSAGE_CHARS), state);
  }

  return sendJson(res, 404, { error: "not found" });
}

/** Constant-time bearer token check (scheme is case-insensitive per RFC 7235). */
function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

async function streamTurn(
  res: ServerResponse,
  req: IncomingMessage,
  deps: RuntimeApiDeps,
  message: string,
  state: ApiState,
): Promise<void> {
  state.sseCount += 1;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const sse = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Keep-alive ping so proxies don't drop the connection.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15000);
  // If the client disconnects, stop pinging immediately (the turn itself still
  // completes — Node can't cancel it — but we free the SSE slot and stop writing).
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    clearInterval(ping);
  };
  req.on("close", onClose);
  try {
    sse("start", {});
    const reply = await deps.runTurn(message);
    if (!clientGone) {
      sse("reply", { reply });
      sse("done", { ok: true });
    }
  } catch (err: any) {
    if (!clientGone) sse("error", { error: String(err?.message ?? err) });
  } finally {
    clearInterval(ping);
    state.release();
    state.sseCount = Math.max(0, state.sseCount - 1);
    if (!res.writableEnded) res.end();
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (v: any) => {
      if (settled) return;
      settled = true;
      chunks.length = 0; // release buffers
      resolve(v);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length; // count BYTES, not JS string length
      if (size > 1_000_000) {
        done(null); // oversized -> caller treats as bad request
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        done(null);
      }
    });
    // destroy() may emit 'close'/'aborted' instead of 'error' — settle on all.
    req.on("error", () => done(null));
    req.on("close", () => done(null));
    req.on("aborted", () => done(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}
