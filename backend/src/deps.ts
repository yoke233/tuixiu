import type { PrismaClient } from "@prisma/client";

export type PrismaDeps = Pick<
  PrismaClient,
  | "agent"
  | "approval"
  | "artifact"
  | "event"
  | "issue"
  | "platformTextTemplate"
  | "project"
  | "projectTextTemplate"
  | "roleTemplate"
  | "run"
  | "sandboxInstance"
  | "step"
  | "task"
  | "user"
>;

export type SendToAgent = (proxyId: string, payload: unknown) => Promise<void>;
