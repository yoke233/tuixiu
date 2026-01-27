import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type UserRole = "admin" | "pm" | "reviewer" | "dev";

export type AuthUser = {
  userId: string;
  username: string;
  role: UserRole;
};

export type AuthHelpers = {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRoles: (roles: UserRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  sign: (user: AuthUser) => string;
};

export async function registerAuth(server: FastifyInstance, opts: { jwtSecret: string }): Promise<AuthHelpers> {
  await server.register(jwt, { secret: opts.jwtSecret });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await (request as any).jwtVerify();
    } catch {
      reply.code(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "未登录" } });
    }
  };

  const requireRoles =
    (roles: UserRole[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      await authenticate(request, reply);
      if ((reply as any).sent) return;

      const role = String(((request as any).user as any)?.role ?? "");
      if (!roles.includes(role as UserRole)) {
        reply.code(403).send({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
      }
    };

  const sign = (user: AuthUser) => (server as any).jwt.sign(user);

  return { authenticate, requireRoles, sign };
}

