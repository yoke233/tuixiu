import Fastify from "fastify";
import { ZodError } from "zod";

export function createHttpServer() {
  const server = Fastify({ logger: false });
  server.setErrorHandler((err, request, reply) => {
    const pathOnly = String(request.url ?? "").split("?")[0] ?? "";
    if (pathOnly.startsWith("/api/") && (err instanceof ZodError || String((err as any)?.name ?? "") === "ZodError")) {
      reply.code(400).send({
        success: false,
        error: { code: "BAD_REQUEST", message: "参数校验失败", details: (err as any).errors ?? [] },
      });
      return;
    }
    reply.send(err);
  });
  return server;
}

export async function flushMicrotasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
