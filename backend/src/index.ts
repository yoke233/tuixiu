import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import { loadEnv } from "./config.js";
import { prisma } from "./db.js";
import { makeAgentRoutes } from "./routes/agents.js";
import { makeApprovalRoutes } from "./routes/approvals.js";
import { makeGitHubIssueRoutes } from "./routes/githubIssues.js";
import { makeGitHubWebhookRoutes } from "./routes/githubWebhooks.js";
import { makeGitLabWebhookRoutes } from "./routes/gitlabWebhooks.js";
import { makeIssueRoutes } from "./routes/issues.js";
import { makeMessageInboundRoutes } from "./routes/messageInbound.js";
import { makePmRoutes } from "./routes/pm.js";
import { makeProjectRoutes } from "./routes/projects.js";
import { makeRoleTemplateRoutes } from "./routes/roleTemplates.js";
import { makeRunRoutes } from "./routes/runs.js";
import { createPmAutomation } from "./services/pm/pmAutomation.js";
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

const createWorkspace = async ({ runId, baseBranch, name }: { runId: string; baseBranch: string; name: string }) => {
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
};

const pm = createPmAutomation({
  prisma,
  sendToAgent: wsGateway.sendToAgent,
  createWorkspace,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});

server.register(
  makeIssueRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    createWorkspace,
    onIssueCreated: pm.triggerAutoStart,
  }),
  {
    prefix: "/api/issues"
  },
);
server.register(makeRunRoutes({ prisma, sendToAgent: wsGateway.sendToAgent }), { prefix: "/api/runs" });
server.register(makeApprovalRoutes({ prisma }), { prefix: "/api/approvals" });
server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });
server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeGitHubIssueRoutes({ prisma, onIssueUpserted: pm.triggerAutoStart }), { prefix: "/api/projects" });
server.register(
  makeGitHubWebhookRoutes({ prisma, webhookSecret: env.GITHUB_WEBHOOK_SECRET, onIssueUpserted: pm.triggerAutoStart }),
  { prefix: "/api/webhooks" },
);
server.register(
  makeGitLabWebhookRoutes({ prisma, webhookSecret: env.GITLAB_WEBHOOK_SECRET, onIssueUpserted: pm.triggerAutoStart }),
  { prefix: "/api/webhooks" },
);
server.register(
  makeMessageInboundRoutes({ prisma, webhookSecret: env.MESSAGE_WEBHOOK_SECRET, onIssueUpserted: pm.triggerAutoStart }),
  { prefix: "/api/integrations" },
);
server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });

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
