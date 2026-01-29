import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";

import type { AuthHelpers, UserRole } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";

function normalizeUsername(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

function toPublicUser(u: any) {
  return { id: u.id, username: u.username, role: u.role };
}

export function makeAuthRoutes(deps: {
  prisma: PrismaDeps;
  auth: AuthHelpers;
  bootstrap?: { username?: string; password?: string };
}): FastifyPluginAsync {
  return async (server) => {
    server.post("/bootstrap", async (request) => {
      const bodySchema = z.object({
        username: z.string().min(1).max(100).optional(),
        password: z.string().min(6).max(200).optional(),
      });
      const body = bodySchema.parse(request.body ?? {});

      const count = await deps.prisma.user.count().catch(() => 0);
      if (count > 0) {
        return { success: false, error: { code: "ALREADY_BOOTSTRAPPED", message: "已存在用户，无法 bootstrap" } };
      }

      const username = normalizeUsername(body.username ?? deps.bootstrap?.username);
      const password = typeof body.password === "string" ? body.password : deps.bootstrap?.password;
      if (!username || !password) {
        return { success: false, error: { code: "BAD_REQUEST", message: "需要 username/password" } };
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await deps.prisma.user.create({
        data: { id: uuidv7(), username, passwordHash, role: "admin" as UserRole } as any,
      });

      const token = deps.auth.sign({ userId: user.id, username: user.username, role: user.role });
      return { success: true, data: { token, user: toPublicUser(user) } };
    });

    server.post("/login", async (request) => {
      const bodySchema = z.object({
        username: z.string().min(1).max(100),
        password: z.string().min(1).max(200),
      });
      const body = bodySchema.parse(request.body ?? {});

      const username = normalizeUsername(body.username);
      const user = await deps.prisma.user.findUnique({ where: { username } });
      if (!user) {
        return { success: false, error: { code: "BAD_CREDENTIALS", message: "用户名或密码错误" } };
      }

      const ok = await bcrypt.compare(body.password, user.passwordHash);
      if (!ok) {
        return { success: false, error: { code: "BAD_CREDENTIALS", message: "用户名或密码错误" } };
      }

      const token = deps.auth.sign({ userId: user.id, username: user.username, role: user.role });
      return { success: true, data: { token, user: toPublicUser(user) } };
    });

    server.get("/me", { preHandler: deps.auth.authenticate }, async (request) => {
      const user = (request as any).user;
      return { success: true, data: { user } };
    });
  };
}

