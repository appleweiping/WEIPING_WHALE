export function errorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return typeof error;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compact(redactSecrets(message), 300);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-...redacted")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer ...redacted")
    .replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1=...redacted");
}

export function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

export function endpointConfigured(url: string | undefined): boolean {
  return Boolean(url && url.trim());
}

export function endpointHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

