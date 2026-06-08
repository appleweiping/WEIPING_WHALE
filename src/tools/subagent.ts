/**
 * tools/subagent.ts — bounded sub-agent pool for WEIPING_WHALE.
 *
 * Exposes `agent_open` (spawn a background child agent on an objective) and
 * `agent_eval` (read a child's result/transcript) to the model. Children are
 * real Agent instances sharing the parent's config + MCP, but flagged as
 * sub-agents (low routing effort) and capped in number and spawn depth. Each
 * child runs to completion in the background and reports a completion sentinel.
 */
import { registerTool } from "./registry.js";
import { AsyncLocalStorage } from "async_hooks";
import type { Agent } from "../agent.js";
import type { Config } from "../config.js";
import type { MCPManager } from "../mcp/manager.js";

export type SubAgentStatus = "running" | "completed" | "failed";

export interface SubAgentRecord {
  id: string;
  objective: string;
  status: SubAgentStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  steps: number;
}

const DONE_SENTINEL = "<weiping-whale:subagent.done>";
const MAX_OBJECTIVE_CHARS = 8000;
const MAX_RESULT_CHARS = 24000;
const MAX_RECORDS = 50;
const CHILD_TIMEOUT_MS = 300000; // 5 min hard wall-clock cap per child

export interface SubAgentDeps {
  config: Config;
  mcpManager: MCPManager;
  makeAgent: (config: Config, mcp: MCPManager) => Agent;
  maxAgents: number;
  maxDepth: number;
  depth: number;
  childTimeoutMs?: number;
}

export class SubAgentManager {
  private agents = new Map<string, SubAgentRecord>();
  private running = 0;
  private counter = 0;
  private deps: SubAgentDeps;

  constructor(deps: SubAgentDeps) {
    this.deps = deps;
  }

  private newId(): string {
    this.counter += 1;
    return `sa-${this.counter}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Spawn a background child agent. Returns its id, or an error string. */
  open(objective: string): { id?: string; error?: string } {
    // Depth check uses BOTH the async-context depth and the manager's own depth
    // (belt-and-suspenders: if async context is ever lost, deps.depth still caps).
    const effectiveDepth = Math.max(currentDepth(), this.deps.depth);
    if (effectiveDepth >= this.deps.maxDepth) {
      return { error: `max sub-agent spawn depth (${this.deps.maxDepth}) reached` };
    }
    if (this.running >= this.deps.maxAgents) {
      return { error: `sub-agent pool is full (${this.deps.maxAgents} running); use agent_eval to collect results first` };
    }
    const trimmed = objective.slice(0, MAX_OBJECTIVE_CHARS);
    const spawnDepth = effectiveDepth + 1;
    const id = this.newId();
    const record: SubAgentRecord = {
      id,
      objective: trimmed,
      status: "running",
      startedAt: Date.now(),
      steps: 0,
    };
    this.evictOldRecords();
    this.agents.set(id, record);
    this.running += 1;

    // Fire-and-forget; agent_eval polls for the result. The child runs inside an
    // async-context depth frame so its own agent_open calls see the deeper level.
    void depthStore.run(spawnDepth, () => this.runChild(record, trimmed));
    return { id };
  }

  /** Evict the oldest finished records once we exceed the retention cap. */
  private evictOldRecords(): void {
    // Keep at least enough headroom for all concurrently-running agents.
    const cap = Math.max(MAX_RECORDS, this.deps.maxAgents + 1);
    if (this.agents.size < cap) return;
    const finished = [...this.agents.values()]
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    for (const r of finished) {
      if (this.agents.size < cap) break;
      this.agents.delete(r.id);
    }
  }

  private async runChild(record: SubAgentRecord, objective: string): Promise<void> {
    const timeoutMs = this.deps.childTimeoutMs ?? CHILD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = this.deps.makeAgent(this.deps.config, this.deps.mcpManager);
      // Children route at low effort and never recurse past the depth cap.
      child.setAutoRoute(false);
      const prompt =
        `You are a sub-agent with a single objective. Complete it autonomously, then give a concise ` +
        `summary of what you found or did.\n\nOBJECTIVE: ${objective}`;
      // Hard wall-clock cap so a hung child can never permanently hold a pool slot.
      const reply = await Promise.race([
        child.run(prompt, {
          onToolEnd: () => {
            // Only count steps while still running; a timed-out child whose record
            // is already settled must not keep mutating it.
            if (record.status === "running") record.steps += 1;
          },
        }),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        }),
      ]);
      record.status = "completed";
      record.result = reply.slice(0, MAX_RESULT_CHARS);
    } catch (err: any) {
      record.status = "failed";
      record.error = String(err?.message ?? err).slice(0, 2000);
    } finally {
      if (timer) clearTimeout(timer); // don't leak the timer when the child wins the race
      record.finishedAt = Date.now();
      this.running = Math.max(0, this.running - 1);
    }
  }

  /** Read a child's current state. */
  evalAgent(id: string): { record?: SubAgentRecord; error?: string } {
    const record = this.agents.get(id);
    if (!record) return { error: `no sub-agent '${id}'` };
    return { record };
  }

  list(): SubAgentRecord[] {
    return [...this.agents.values()];
  }

  /** Wait (bounded) for a child to finish, returning a formatted result string. */
  async waitFor(id: string, timeoutMs = 30000): Promise<string> {
    const record = this.agents.get(id);
    if (!record) return `no sub-agent '${id}'`;
    const deadline = Date.now() + timeoutMs;
    while (record.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.format(record);
  }

  format(record: SubAgentRecord): string {
    if (record.status === "running") {
      return `Sub-agent ${record.id} still running (${record.steps} tool steps so far). Call agent_eval again later.`;
    }
    if (record.status === "failed") {
      return `Sub-agent ${record.id} FAILED: ${record.error}\n${DONE_SENTINEL}`;
    }
    const secs = record.finishedAt ? ((record.finishedAt - record.startedAt) / 1000).toFixed(1) : "?";
    return `Sub-agent ${record.id} completed in ${secs}s (${record.steps} tool steps):\n${record.result ?? ""}\n${DONE_SENTINEL}`;
  }
}

// Module-level active manager (set per session in index.ts).
let active: SubAgentManager | null = null;
// Nesting depth tracked via async context so SIBLING children (run concurrently
// from the same parent) do not inflate depth — only true parent->child nesting
// does. A child's run executes inside depthStore.run(parentDepth+1, ...).
const depthStore = new AsyncLocalStorage<number>();
function currentDepth(): number {
  return depthStore.getStore() ?? 0;
}
export function setActiveSubAgentManager(m: SubAgentManager | null): void {
  active = m;
}
export function getActiveSubAgentManager(): SubAgentManager | null {
  return active;
}

registerTool(
  "agent_open",
  "Spawn a background sub-agent to work on a focused objective in parallel (e.g. explore a " +
    "subsystem, run a broad search, draft a change). Returns an agent id immediately; the child " +
    "runs in the background. Collect its result later with agent_eval. Use for independent, " +
    "parallelizable subtasks — not for the main line of work.",
  {
    type: "object",
    properties: {
      objective: { type: "string", description: "A clear, self-contained objective for the sub-agent." },
    },
    required: ["objective"],
  },
  async ({ objective }) => {
    if (!active) return { output: "Sub-agents are not enabled in this session.", error: true };
    if (typeof objective !== "string" || !objective.trim()) {
      return { output: "objective is required", error: true };
    }
    const res = active.open(objective.trim());
    if (res.error) return { output: res.error, error: true };
    return { output: `Opened sub-agent ${res.id}. Use agent_eval with this id to collect its result.` };
  },
);

registerTool(
  "agent_eval",
  "Collect the result of a sub-agent previously opened with agent_open. If the sub-agent is still " +
    "running, this waits briefly and then reports progress. The completion sentinel " +
    `${DONE_SENTINEL} marks a finished result.`,
  {
    type: "object",
    properties: {
      id: { type: "string", description: "The sub-agent id returned by agent_open." },
      wait_ms: { type: "number", description: "Max milliseconds to wait for completion (default 30000)." },
    },
    required: ["id"],
  },
  async ({ id, wait_ms }) => {
    if (!active) return { output: "Sub-agents are not enabled in this session.", error: true };
    if (typeof id !== "string") return { output: "id is required", error: true };
    const out = await active.waitFor(id, typeof wait_ms === "number" ? Math.min(120000, Math.max(0, wait_ms)) : 30000);
    return { output: out };
  },
);

export { DONE_SENTINEL };
