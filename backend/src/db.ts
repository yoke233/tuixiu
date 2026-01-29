import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export type PrismaDeps = PrismaClient;

export type SendToAgent = (proxyId: string, payload: unknown) => Promise<void>;
