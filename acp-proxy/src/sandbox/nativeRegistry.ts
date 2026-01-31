import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type NativeRegistryEntry = {
  instanceName: string;
  pid: number;
  workspaceHostPath: string;
  startedAt: string;
};

type NativeRegistryFile = {
  version: 1;
  instances: NativeRegistryEntry[];
};

function sanitizeEntries(entries: unknown): NativeRegistryEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: NativeRegistryEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const raw = item as any;
    const instanceName = typeof raw.instanceName === "string" ? raw.instanceName.trim() : "";
    const pid = typeof raw.pid === "number" && Number.isFinite(raw.pid) ? raw.pid : null;
    const workspaceHostPath = typeof raw.workspaceHostPath === "string" ? raw.workspaceHostPath.trim() : "";
    const startedAt = typeof raw.startedAt === "string" ? raw.startedAt.trim() : "";
    if (!instanceName || !pid || !workspaceHostPath || !startedAt) continue;
    out.push({ instanceName, pid, workspaceHostPath, startedAt });
  }
  return out;
}

export async function readNativeRegistry(registryPath: string): Promise<NativeRegistryEntry[]> {
  const text = await readFile(registryPath, "utf8").catch(() => "");
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as NativeRegistryFile;
    return sanitizeEntries((parsed as any)?.instances);
  } catch {
    return [];
  }
}

export async function writeNativeRegistry(
  registryPath: string,
  entries: NativeRegistryEntry[],
): Promise<void> {
  const dir = path.dirname(registryPath);
  await mkdir(dir, { recursive: true });
  const unique = new Map<string, NativeRegistryEntry>();
  for (const e of entries) unique.set(e.instanceName, e);
  const payload: NativeRegistryFile = { version: 1, instances: Array.from(unique.values()) };
  await writeFile(registryPath, JSON.stringify(payload, null, 2), "utf8");
}

export async function upsertNativeRegistryEntry(
  registryPath: string,
  entry: NativeRegistryEntry,
): Promise<void> {
  const entries = await readNativeRegistry(registryPath);
  const next = entries.filter((e) => e.instanceName !== entry.instanceName);
  next.push(entry);
  await writeNativeRegistry(registryPath, next);
}

export async function removeNativeRegistryEntry(
  registryPath: string,
  instanceName: string,
): Promise<void> {
  const entries = await readNativeRegistry(registryPath);
  const next = entries.filter((e) => e.instanceName !== instanceName);
  await writeNativeRegistry(registryPath, next);
}

