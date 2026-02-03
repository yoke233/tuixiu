import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type BootstrapTokenFile = { token: string; createdAt: string };

export async function readBootstrapToken(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as BootstrapTokenFile;
    if (!parsed || typeof parsed.token !== "string") return null;
    const token = parsed.token.trim();
    return token ? token : null;
  } catch {
    return null;
  }
}

export async function writeBootstrapToken(filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const token = crypto.randomBytes(16).toString("hex");
  const payload: BootstrapTokenFile = { token, createdAt: new Date().toISOString() };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return token;
}

export async function removeBootstrapToken(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
