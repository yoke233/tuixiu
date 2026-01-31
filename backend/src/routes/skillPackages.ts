import { createReadStream } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { SkillPackageStore } from "../modules/skills/skillPackageStore.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function makeSkillPackageRoutes(deps: { packages: SkillPackageStore }): FastifyPluginAsync {
  return async (server) => {
    const requireProxy = async (request: any, reply: any) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "未登录" } });
        return;
      }

      const user = isRecord(request.user) ? (request.user as any) : null;
      if (!user || user.type !== "acp_proxy") {
        reply.code(403).send({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
        return;
      }
    };

    server.get("/skills/packages/:contentHash.zip", { preHandler: requireProxy }, async (request, reply) => {
      const paramsSchema = z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/i) });
      const { contentHash } = paramsSchema.parse(request.params);

      const info = await deps.packages.getInfo({ contentHash });
      if (!info) {
        reply.code(404);
        return { success: false, error: { code: "NOT_FOUND", message: "技能包不存在" } };
      }

      const etag = `"${contentHash}"`;
      if (String(request.headers["if-none-match"] ?? "").trim() === etag) {
        reply.code(304);
        return reply.send();
      }

      reply.header("etag", etag);
      reply.header("cache-control", "public, max-age=31536000, immutable");
      reply.header("content-length", String(info.size));
      reply.type("application/zip");
      return reply.send(createReadStream(info.filePath));
    });
  };
}
