import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import { loadEnv } from "./config.js";
import { prisma } from "./db.js";
import { makeAgentRoutes } from "./routes/agents.js";
import { makeGitHubIssueRoutes } from "./routes/githubIssues.js";
import { makeIssueRoutes } from "./routes/issues.js";
import { makeProjectRoutes } from "./routes/projects.js";
import { makeRoleTemplateRoutes } from "./routes/roleTemplates.js";
import { makeRunRoutes } from "./routes/runs.js";
import { createRunWorkspace } from "./utils/runWorkspace.js";
import { startWorkspaceCleanupLoop } from "./services/workspaceCleanup.js";
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

server.register(
  makeIssueRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    createWorkspace: async ({ runId, baseBranch, name }) => {
      const run = await prisma.run.findUnique({
        where: { id: runId },
        include: { issue: { include: { project: true } } },
      });
      const project = (run as any)?.issue?.project;
      if (!project) {
        throw new Error("Run 对应的 Project 不存在");
      }

      return await createRunWorkspace({
        runId,
        baseBranch,
        name,
        project,
        workspacesRoot: env.WORKSPACES_ROOT,
        repoCacheRoot: env.REPO_CACHE_ROOT,
      });
    },
  }),
  {
  prefix: "/api/issues"
  },
);
server.register(makeRunRoutes({ prisma, sendToAgent: wsGateway.sendToAgent }), { prefix: "/api/runs" });
server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });
server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeGitHubIssueRoutes({ prisma }), { prefix: "/api/projects" });

startWorkspaceCleanupLoop({
  prisma,
  workspacesRoot: env.WORKSPACES_ROOT,
  repoCacheRoot: env.REPO_CACHE_ROOT,
  workspaceTtlDays: env.WORKSPACE_TTL_DAYS,
  repoCacheTtlDays: env.REPO_CACHE_TTL_DAYS,
  intervalSeconds: env.CLEANUP_INTERVAL_SECONDS,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});

await server.listen({ port: env.PORT, host: env.HOST });
