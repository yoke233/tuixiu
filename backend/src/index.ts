import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import { loadEnv } from "./config.js";
import { prisma } from "./db.js";
import { registerAuth } from "./auth.js";
import { makeAgentRoutes } from "./routes/agents.js";
import { makeApprovalRoutes } from "./routes/approvals.js";
import { makeArtifactRoutes } from "./routes/artifacts.js";
import { makeAuthRoutes } from "./routes/auth.js";
import { makeGitHubIssueRoutes } from "./routes/githubIssues.js";
import { makeGitHubWebhookRoutes } from "./routes/githubWebhooks.js";
import { makeGitLabWebhookRoutes } from "./routes/gitlabWebhooks.js";
import { makeIssueRoutes } from "./routes/issues.js";
import { makeMessageInboundRoutes } from "./routes/messageInbound.js";
import { makePmRoutes } from "./routes/pm.js";
import { makeProjectRoutes } from "./routes/projects.js";
import { makeRoleTemplateRoutes } from "./routes/roleTemplates.js";
import { makeRunRoutes } from "./routes/runs.js";
import { makeStepRoutes } from "./routes/steps.js";
import { makeTaskRoutes } from "./routes/tasks.js";
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

const auth = await registerAuth(server, { jwtSecret: env.JWT_SECRET });
server.register(
  makeAuthRoutes({
    prisma,
    auth,
    bootstrap: { username: env.BOOTSTRAP_ADMIN_USERNAME, password: env.BOOTSTRAP_ADMIN_PASSWORD },
  }),
  { prefix: "/api/auth" },
);

server.addHook("preHandler", async (request, reply) => {
  const url = String(request.url ?? "");
  const pathOnly = url.split("?")[0] ?? url;
  if (!pathOnly.startsWith("/api/")) return;
  if (pathOnly.startsWith("/api/auth/")) return;
  if (pathOnly.startsWith("/api/webhooks/")) return;
  if (pathOnly.startsWith("/api/integrations/")) return;
  if (request.method === "GET") return;

  await auth.authenticate(request, reply);
  if ((reply as any).sent) return;

  const role = String(((request as any).user as any)?.role ?? "");

  const isProjectCreate = request.method === "POST" && pathOnly === "/api/projects";
  const isProjectUpdate = request.method === "PATCH" && /^\/api\/projects\/[0-9a-f-]{36}$/i.test(pathOnly);
  const isRoleTemplateMutation = /^\/api\/projects\/[0-9a-f-]{36}\/roles(\/|$)/i.test(pathOnly) && request.method !== "GET";

  if ((isProjectCreate || isProjectUpdate || isRoleTemplateMutation) && role !== "admin") {
    reply.code(403).send({ success: false, error: { code: "FORBIDDEN", message: "仅 admin 可修改 Project/Role 配置" } });
  }
});

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
server.register(makeRunRoutes({ prisma, sendToAgent: wsGateway.sendToAgent, broadcastToClients: wsGateway.broadcastToClients }), { prefix: "/api/runs" });
server.register(makeApprovalRoutes({ prisma }), { prefix: "/api/approvals" });
server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });
server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeGitHubIssueRoutes({ prisma, onIssueUpserted: pm.triggerAutoStart }), { prefix: "/api/projects" });
server.register(
  makeGitHubWebhookRoutes({
    prisma,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    onIssueUpserted: pm.triggerAutoStart,
    broadcastToClients: wsGateway.broadcastToClients,
  }),
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
server.register(makeTaskRoutes({ prisma, broadcastToClients: wsGateway.broadcastToClients }), { prefix: "/api" });
server.register(
  makeStepRoutes({ prisma, sendToAgent: wsGateway.sendToAgent, createWorkspace, autoDispatch: true, broadcastToClients: wsGateway.broadcastToClients }),
  { prefix: "/api" },
);
server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

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
