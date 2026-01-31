import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolveIdentityPath(): string {
  const raw = process.env.ACP_PROXY_IDENTITY_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.join(os.homedir(), ".tuixiu", "acp-proxy", "identity.json");
}

export async function loadOrCreateAgentId(): Promise<string> {
  const fromEnv = process.env.ACP_PROXY_AGENT_ID?.trim();
  if (fromEnv) return fromEnv;

  const identityPath = resolveIdentityPath();
  try {
    const raw = await readFile(identityPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.agentId === "string" && parsed.agentId.trim()) {
      return parsed.agentId.trim();
    }
  } catch {
    // ignore and create a new one
  }

  const hostnameRaw = os.hostname().trim();
  const hostPart = hostnameRaw
    ? hostnameRaw.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
    : "host";
  const agentId = `${hostPart || "host"}-${randomUUID()}`;

  await mkdir(path.dirname(identityPath), { recursive: true });

  const body = JSON.stringify(
    { agentId, hostname: hostnameRaw, createdAt: new Date().toISOString() },
    null,
    2,
  );
  const tmpPath = `${identityPath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, body, "utf8");
  try {
    await rename(tmpPath, identityPath);
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
    try {
      const raw = await readFile(identityPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.agentId === "string" && parsed.agentId.trim()) {
        return parsed.agentId.trim();
      }
    } catch {
      // ignore
    }
    await writeFile(identityPath, body, "utf8");
  }

  return agentId;
}

