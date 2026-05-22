import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { assertWritablePath } from "./sandbox.js";

export type PatchKind = "write" | "edit";

export interface PendingFilePatch {
  id: string;
  kind: PatchKind;
  path: string;
  before: string;
  after: string;
  diff: string;
  created_at: string;
}

const pendingFilePatches = new Map<string, PendingFilePatch>();

export function getWriteMode(): "preview" | "direct" {
  return process.env.DEEPSEEK_WRITE_MODE === "direct" ? "direct" : "preview";
}

export function createFilePatch(kind: PatchKind, path: string, after: string): PendingFilePatch {
  assertWritablePath(path);
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const patch: PendingFilePatch = {
    id: randomUUID().slice(0, 8),
    kind,
    path,
    before,
    after,
    diff: buildUnifiedDiff(path, before, after),
    created_at: new Date().toISOString(),
  };
  pendingFilePatches.set(patch.id, patch);
  return patch;
}

export function listFilePatches(): PendingFilePatch[] {
  return Array.from(pendingFilePatches.values());
}

export function applyFilePatch(id: string): { ok: boolean; message: string; patch?: PendingFilePatch } {
  const patch = pendingFilePatches.get(id);
  if (!patch) return { ok: false, message: `No pending patch: ${id}` };
  try {
    assertWritablePath(patch.path);
  } catch (err: any) {
    return { ok: false, message: err.message, patch };
  }
  const current = existsSync(patch.path) ? readFileSync(patch.path, "utf-8") : "";
  if (current !== patch.before) {
    return {
      ok: false,
      message: `Patch ${id} no longer applies cleanly because ${patch.path} changed after preview. Reject it and ask the agent to regenerate the patch.`,
      patch,
    };
  }
  mkdirSync(dirname(patch.path), { recursive: true });
  writeFileSync(patch.path, patch.after, "utf-8");
  pendingFilePatches.delete(id);
  return { ok: true, message: `Applied patch ${id} to ${patch.path}`, patch };
}

export function rejectFilePatch(id: string): boolean {
  return pendingFilePatches.delete(id);
}

export function formatPatchList(): string {
  const patches = listFilePatches();
  if (patches.length === 0) return "No pending file patches.";
  return patches
    .map((patch) => `${patch.id} ${patch.kind} ${patch.path}\n${indent(truncate(patch.diff, 4000), "  ")}`)
    .join("\n\n");
}

export function formatPatchCreated(patch: PendingFilePatch): string {
  return [
    `Patch preview created: ${patch.id}`,
    `Path: ${patch.path}`,
    "Review it with /patches, apply it with /apply " + patch.id + ", or reject it with /reject " + patch.id + ".",
    "",
    truncate(patch.diff, 12000),
  ].join("\n");
}

function buildUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- ${path}\n+++ ${path}\n(no changes)`;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  let emitted = 0;
  for (let index = 0; index < max; index++) {
    const oldLine = beforeLines[index];
    const newLine = afterLines[index];
    if (oldLine === newLine) {
      if (emitted > 0 && emitted < 160) lines.push(` ${oldLine ?? ""}`);
      continue;
    }
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
    emitted += 1;
    if (emitted >= 160) {
      lines.push("... diff truncated ...");
      break;
    }
  }
  return lines.join("\n");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... truncated ...` : value;
}

function indent(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
