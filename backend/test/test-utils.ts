import Fastify from "fastify";

export function createHttpServer() {
  return Fastify({ logger: false });
}

export async function flushMicrotasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

