import type { FastifyPluginAsync } from "fastify";

export function makeHealthRoutes(): FastifyPluginAsync {
  return async (server) => {
    server.get("/health", async () => {
      return { success: true, data: { ok: true } };
    });
  };
}

