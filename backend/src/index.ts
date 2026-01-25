import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import { loadEnv } from "./config.js";
import { prisma } from "./db.js";
import { makeAgentRoutes } from "./routes/agents.js";
import { makeIssueRoutes } from "./routes/issues.js";
import { makeProjectRoutes } from "./routes/projects.js";
import { makeRunRoutes } from "./routes/runs.js";
import { createWebSocketGateway } from "./websocket/gateway.js";

const env = loadEnv();

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL
  }
});

await server.register(cors, { origin: true });
await server.register(websocket);

const wsGateway = createWebSocketGateway({ prisma });
wsGateway.init(server);

server.register(makeIssueRoutes({ prisma, sendToAgent: wsGateway.sendToAgent }), {
  prefix: "/api/issues"
});
server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });
server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });
server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

await server.listen({ port: env.PORT, host: env.HOST });
