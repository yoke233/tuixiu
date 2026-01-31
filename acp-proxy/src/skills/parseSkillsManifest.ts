import { isRecord } from "../utils/validate.js";
import type { SkillsManifest } from "./skillsTypes.js";

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

function isSafeStorageUri(storageUri: string, contentHash: string): boolean {
  const raw = storageUri.trim();
  if (!raw.startsWith("/")) return false;
  // Protocol-relative (e.g. //evil.com) or malformed absolute-ish (e.g. ///evil.com)
  if (raw.startsWith("//")) return false;

  const url = new URL(raw, "http://localhost");
  if (url.origin !== "http://localhost") return false;

  const expected = `/api/acp-proxy/skills/packages/${contentHash}.zip`;
  if (url.pathname !== expected) return false;
  return true;
}

export function parseSkillsManifest(value: unknown): SkillsManifest | null {
  if (!isRecord(value)) return null;
  const runId = asNonEmptyString((value as any).runId);
  const skillVersionsRaw = (value as any).skillVersions;
  if (!runId || !Array.isArray(skillVersionsRaw)) return null;

  const skillVersions: SkillsManifest["skillVersions"] = [];
  for (const item of skillVersionsRaw) {
    if (!isRecord(item)) return null;
    const skillId = asNonEmptyString((item as any).skillId);
    const skillName = asNonEmptyString((item as any).skillName);
    const skillVersionId = asNonEmptyString((item as any).skillVersionId);
    const contentHash = asNonEmptyString((item as any).contentHash);
    const storageUri = asNonEmptyString((item as any).storageUri);
    if (!skillId || !skillName || !skillVersionId || !contentHash || !storageUri) return null;
    if (!isSha256Hex(contentHash)) return null;
    if (!isSafeStorageUri(storageUri, contentHash)) return null;
    skillVersions.push({ skillId, skillName, skillVersionId, contentHash, storageUri });
  }

  return { runId, skillVersions };
}
