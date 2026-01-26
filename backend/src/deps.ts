import type { PrismaClient } from "@prisma/client";

export type PrismaDeps = Pick<
  PrismaClient,
  "agent" | "artifact" | "event" | "issue" | "project" | "roleTemplate" | "run"
>;

export type SendToAgent = (proxyId: string, payload: unknown) => Promise<void>;
