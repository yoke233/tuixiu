import crypto from "node:crypto";

import type { PrismaDeps } from "../../db.js";

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createRefreshSession(
  prisma: PrismaDeps,
  input: {
    userId: string;
    token: string;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
    rotatedFromId?: string | null;
  },
) {
  return prisma.refreshSession.create({
    data: {
      id: crypto.randomUUID(),
      userId: input.userId,
      tokenHash: hashRefreshToken(input.token),
      expiresAt: input.expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      ...(input.rotatedFromId ? { rotatedFromId: input.rotatedFromId } : {}),
    },
  } as any);
}

export async function findSessionByToken(prisma: PrismaDeps, token: string) {
  return prisma.refreshSession.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
}

export async function revokeSession(prisma: PrismaDeps, id: string) {
  return prisma.refreshSession.update({ where: { id }, data: { revokedAt: new Date() } });
}

export async function revokeAllForUser(prisma: PrismaDeps, userId: string) {
  return prisma.refreshSession.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
}
