import { randomUUID } from "crypto";

export type ApprovalMode = "on-request" | "never" | "auto";
export type ShellRiskLevel = "safe" | "approval_required" | "blocked";

export interface ShellRisk {
  level: ShellRiskLevel;
  reason: string;
}

export interface PendingShellApproval {
  id: string;
  command: string;
  timeout: number;
  reason: string;
  created_at: string;
}

const pendingShellApprovals = new Map<string, PendingShellApproval>();

const blockedPatterns: Array<[RegExp, string]> = [
  [/\brm\s+-rf\s+\//i, "recursive delete from filesystem root"],
  [/\bRemove-Item\b.*\b-Recurse\b.*\b(C:\\|D:\\|\/|\*)/i, "recursive PowerShell delete over a broad target"],
  [/\bformat\b\s+[a-z]:/i, "disk format command"],
  [/\bdiskpart\b/i, "disk partition command"],
  [/\bshutdown\b|\bRestart-Computer\b|\bStop-Computer\b/i, "system shutdown or restart"],
  [/\bSet-ExecutionPolicy\b/i, "PowerShell execution policy change"],
  [/\breg\s+delete\b/i, "registry deletion"],
  [/\bnet\s+user\b/i, "user account modification"],
  [/\bchmod\s+-R\s+777\s+\//i, "recursive world-writable permission change"],
  [/\bdd\s+if=/i, "raw disk write/read command"],
];

const approvalPatterns: Array<[RegExp, string]> = [
  [/\brm\b|\bdel\b|\brmdir\b|\bRemove-Item\b/i, "delete command"],
  [/\bgit\s+(reset|clean|checkout|rebase)\b/i, "history or working-tree rewrite"],
  [/\b(mv|move|cp|copy|xcopy|robocopy|Set-Content|Out-File)\b|(^|[^>])>[^>]/i, "file mutation or shell redirection"],
  [/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|publish)\b|\bpip\s+install\b|\buv\s+(pip\s+)?install\b/i, "dependency or package registry operation"],
  [/\bgit\s+push\b.*(--force|-f|\+[^\s]+)/i, "force push"],
  [/\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+npm\s+publish\b/i, "package publish"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|powershell|iex|Invoke-Expression)\b/i, "downloaded script execution"],
  [/\b(powershell|pwsh)\b.*\s-(enc|encodedcommand)\b/i, "encoded PowerShell command"],
  [/\bscp\b|\brsync\b.*:/i, "remote file transfer"],
  [/\bssh\b/i, "remote shell command"],
];

export function getApprovalMode(): ApprovalMode {
  const raw = (process.env.DEEPSEEK_APPROVAL_MODE || "on-request").toLowerCase();
  if (raw === "auto" || raw === "never" || raw === "on-request") return raw;
  return "on-request";
}

export function setApprovalMode(mode: string): ApprovalMode {
  const normalized = mode.trim().toLowerCase();
  if (normalized !== "auto" && normalized !== "never" && normalized !== "on-request") {
    throw new Error("Approval mode must be on-request, auto, or never");
  }
  process.env.DEEPSEEK_APPROVAL_MODE = normalized;
  return normalized;
}

export function classifyShellCommand(command: string): ShellRisk {
  for (const [pattern, reason] of blockedPatterns) {
    if (pattern.test(command)) return { level: "blocked", reason };
  }
  for (const [pattern, reason] of approvalPatterns) {
    if (pattern.test(command)) return { level: "approval_required", reason };
  }
  return { level: "safe", reason: "no risky shell pattern detected" };
}

export function createShellApproval(command: string, timeout: number, reason: string): PendingShellApproval {
  const approval: PendingShellApproval = {
    id: randomUUID().slice(0, 8),
    command,
    timeout,
    reason,
    created_at: new Date().toISOString(),
  };
  pendingShellApprovals.set(approval.id, approval);
  return approval;
}

export function listShellApprovals(): PendingShellApproval[] {
  return Array.from(pendingShellApprovals.values());
}

export function takeShellApproval(id: string): PendingShellApproval | null {
  const approval = pendingShellApprovals.get(id) ?? null;
  if (approval) pendingShellApprovals.delete(id);
  return approval;
}

export function rejectShellApproval(id: string): boolean {
  return pendingShellApprovals.delete(id);
}
