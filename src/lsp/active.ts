/**
 * lsp/active.ts — module-level active LspManager + a helper that appends a
 * post-edit diagnostics block to a tool result. Single-process CLI scope.
 */
import { LspManager, renderDiagnostics } from "./manager.js";

let active: LspManager | null = null;

export function setActiveLspManager(m: LspManager | null): void {
  active = m;
}
export function getActiveLspManager(): LspManager | null {
  return active;
}

/**
 * Run diagnostics on a freshly-written file and return a string to append to the
 * tool's output (empty string if none / disabled / failed). Never throws.
 */
export async function diagnosticsSuffix(absPath: string): Promise<string> {
  if (!active) return "";
  try {
    const diags = await active.diagnose(absPath);
    const block = renderDiagnostics(absPath, diags);
    return block ? `\n\n${block}` : "";
  } catch {
    return "";
  }
}
