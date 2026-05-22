import { relative, resolve } from "path";

export type SandboxMode = "workspace-write" | "read-only" | "unrestricted";

export function getSandboxMode(): SandboxMode {
  const raw = (process.env.DEEPSEEK_SANDBOX_MODE || "workspace-write").toLowerCase();
  if (raw === "read-only" || raw === "unrestricted" || raw === "workspace-write") return raw;
  return "workspace-write";
}

export function setSandboxMode(mode: string): SandboxMode {
  const normalized = mode.trim().toLowerCase();
  if (normalized !== "workspace-write" && normalized !== "read-only" && normalized !== "unrestricted") {
    throw new Error("Sandbox mode must be workspace-write, read-only, or unrestricted");
  }
  process.env.DEEPSEEK_SANDBOX_MODE = normalized;
  return normalized;
}

export function assertWritablePath(path: string, workspace = process.cwd()): void {
  const mode = getSandboxMode();
  if (mode === "unrestricted") return;
  if (mode === "read-only") {
    throw new Error(`Write blocked by read-only sandbox: ${path}`);
  }
  const target = resolve(path);
  const root = resolve(workspace);
  if (!isInsidePath(target, root)) {
    throw new Error(`Write blocked outside workspace sandbox: ${target}`);
  }
}

export function isInsidePath(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.match(/^[a-zA-Z]:/));
}
