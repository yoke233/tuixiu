import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export function makeAcpProxyRoutes(deps: { bootstrapToken?: string }): FastifyPluginAsync {
  return async (server) => {
    server.post("/register", async (request, reply) => {
      if (!deps.bootstrapToken?.trim()) {
        reply.code(404).send({ success: false, error: { code: "NOT_FOUND", message: "未启用" } });
        return;
      }

      const headerToken = String(request.headers["x-acp-proxy-bootstrap"] ?? "").trim();
      if (!headerToken || headerToken !== deps.bootstrapToken.trim()) {
        reply.code(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "bootstrap token 无效" } });
        return;
      }

      const bodySchema = z.object({
        proxyId: z.string().min(1),
        name: z.string().min(1).optional(),
      });
      const body = bodySchema.parse(request.body ?? {});

      const token = (server as any).jwt.sign(
        { type: "acp_proxy", proxyId: body.proxyId, name: body.name ?? body.proxyId },
        { expiresIn: "30d" },
      );

      return { success: true, data: { token } };
    });
  };
}
