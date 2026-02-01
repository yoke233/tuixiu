import "dotenv/config";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./config.js";
import { prisma } from "./db.js";
import { registerAuth } from "./auth.js";
import { makeAgentRoutes } from "./routes/agents.js";
import { makeApprovalRoutes } from "./routes/approvals.js";
import { makeAcpSessionRoutes } from "./routes/acpSessions.js";
import { makeAcpProxyRoutes } from "./routes/acpProxy.js";
import { makeArtifactRoutes } from "./routes/artifacts.js";
import { makeAuthRoutes } from "./routes/auth.js";
import { makeGitHubIssueRoutes } from "./routes/githubIssues.js";
import { makeGitHubWebhookRoutes } from "./routes/githubWebhooks.js";
import { makeGitLabWebhookRoutes } from "./routes/gitlabWebhooks.js";
import { makeCodeupWebhookRoutes } from "./routes/codeupWebhooks.js";
import { makeHealthRoutes } from "./routes/health.js";
import { makeIssueRoutes } from "./routes/issues.js";
import { makeMessageInboundRoutes } from "./routes/messageInbound.js";
import { makePmRoutes } from "./routes/pm.js";
import { makePolicyRoutes } from "./routes/policies.js";
import { makeWorkflowTemplateRoutes } from "./routes/workflowTemplates.js";
import { makeProjectRoutes } from "./routes/projects.js";
import { makeRoleTemplateRoutes } from "./routes/roleTemplates.js";
import { makeRunRoutes } from "./routes/runs.js";
import { makeSandboxRoutes } from "./routes/sandboxes.js";
import { makeSkillRoutes } from "./routes/skills.js";
import { makeSkillPackageRoutes } from "./routes/skillPackages.js";
import { makeRoleSkillBindingRoutes } from "./routes/roleSkillBindings.js";
import { makeStepRoutes } from "./routes/steps.js";
import { makeTaskRoutes } from "./routes/tasks.js";
import { makeTextTemplateRoutes } from "./routes/textTemplates.js";
import { makeExecutionProfileRoutes } from "./routes/executionProfiles.js";
import { createPmAutomation } from "./modules/pm/pmAutomation.js";
import { createAcpTunnel } from "./modules/acp/acpTunnel.js";
import { createSandboxControlClient } from "./modules/sandbox/sandboxControl.js";
import { startGitHubPollingLoop } from "./modules/scm/githubPolling.js";
import { createLocalAttachmentStore } from "./modules/attachments/localAttachmentStore.js";
import { createLocalSkillPackageStore } from "./modules/skills/skillPackageStore.js";
import { createNpxSkillsCliRunner } from "./modules/skills/npxSkillsCli.js";
import { resolveGitAuthMode } from "./utils/gitAuth.js";
import { defaultRunBranchName } from "./utils/gitWorkspace.js";
import { buildSandboxGitPushEnv } from "./utils/sandboxGitPush.js";
import { createWebSocketGateway } from "./websocket/gateway.js";
import { deriveSandboxInstanceName } from "./utils/sandbox.js";
import type { CreateWorkspace } from "./executors/types.js";

const env = loadEnv();
const attachments = createLocalAttachmentStore({
  rootDir: env.ATTACHMENTS_ROOT,
  maxBytes: env.ATTACHMENTS_MAX_BYTES,
});

const skillPackages = createLocalSkillPackageStore({
  rootDir: env.SKILL_PACKAGES_ROOT,
  basePath: "/api/acp-proxy/skills/packages",
  maxBytes: env.SKILL_PACKAGES_MAX_BYTES,
});

const skillsCli = createNpxSkillsCliRunner({
  npxPackageSpec: env.SKILLS_CLI_NPX_PACKAGE,
  defaultTimeoutMs: env.SKILLS_CLI_TIMEOUT_MS,
});

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL,
  },
});

await server.register(cors, { origin: true, credentials: true });
await server.register(cookie);
await server.register(websocket);

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoots = [
  // legacy behavior: works in Docker images that set cwd to a folder containing `public/`
  path.resolve(process.cwd(), "public"),
  // robust: works regardless of cwd (dev/build within repo)
  path.resolve(thisDir, "..", "public"),
  // local dev convenience: serve built Vite output if present
  path.resolve(thisDir, "..", "..", "frontend", "dist"),
];
function hasFrontendBundle(root: string): boolean {
  if (!fs.existsSync(path.join(root, "index.html"))) return false;
  // Vite build emits absolute `/assets/...` by default, so ensure assets exist to avoid HTML fallback for JS.
  return fs.existsSync(path.join(root, "assets"));
}

const frontendRoot =
  frontendRoots.find((root) => hasFrontendBundle(root)) ??
  frontendRoots.find((root) => fs.existsSync(path.join(root, "index.html"))) ??
  null;
if (frontendRoot) {
  await server.register(staticPlugin, { root: frontendRoot });
}

const auth = await registerAuth(server, { jwtSecret: env.JWT_SECRET });
server.register(
  makeAuthRoutes({
    prisma,
    auth,
    bootstrap: { username: env.BOOTSTRAP_ADMIN_USERNAME, password: env.BOOTSTRAP_ADMIN_PASSWORD },
    cookie: { secure: env.COOKIE_SECURE === "1" || env.COOKIE_SECURE === "true" },
  }),
  { prefix: "/api/auth" },
);
server.register(makeHealthRoutes(), { prefix: "/api" });

server.addHook("preHandler", async (request, reply) => {
  const url = String(request.url ?? "");
  const pathOnly = url.split("?")[0] ?? url;
  if (!pathOnly.startsWith("/api/")) return;
  if (pathOnly.startsWith("/api/auth/")) return;
  if (pathOnly === "/api/health") return;
  if (pathOnly.startsWith("/api/webhooks/")) return;
  if (pathOnly.startsWith("/api/integrations/")) return;
  if (pathOnly.startsWith("/api/admin/acp-proxy/register")) return;

  await auth.authenticate(request, reply);
  if ((reply as any).sent) return;

  const role = String(((request as any).user as any)?.role ?? "");

  const isProjectCreate = request.method === "POST" && pathOnly === "/api/projects";
  const isProjectUpdate =
    request.method === "PATCH" && /^\/api\/projects\/[0-9a-f-]{36}$/i.test(pathOnly);
  const isRoleTemplateMutation =
    /^\/api\/projects\/[0-9a-f-]{36}\/roles(\/|$)/i.test(pathOnly) && request.method !== "GET";
  const isPolicyMutation = pathOnly === "/api/policies";
  const isWorkflowTemplateMutation = pathOnly === "/api/workflow-templates";

  if (
    (isProjectCreate ||
      isProjectUpdate ||
      isRoleTemplateMutation ||
      isPolicyMutation ||
      isWorkflowTemplateMutation) &&
    role !== "admin"
  ) {
    reply
      .code(403)
      .send({
        success: false,
        error: { code: "FORBIDDEN", message: "仅 admin 可修改 Project/Role/Policy 配置" },
      });
  }
});

let sandboxControl: ReturnType<typeof createSandboxControlClient> | null = null;

async function sandboxGitPush(opts: { run: any; branch: string; project: any }) {
  const run = opts.run;
  const proxyId = String(run?.agent?.proxyId ?? run?.issue?.assignedAgent?.proxyId ?? "").trim();
  if (!proxyId) throw new Error("Run.agent.proxyId 缺失");

  const instanceName =
    typeof run?.sandboxInstanceName === "string" && run.sandboxInstanceName.trim()
      ? run.sandboxInstanceName.trim()
      : deriveSandboxInstanceName(String(run?.id ?? ""));
  if (!instanceName) throw new Error("sandboxInstanceName 缺失");

  const env = buildSandboxGitPushEnv(opts.project);
  env.TUIXIU_RUN_BRANCH = opts.branch;
  env.TUIXIU_WORKSPACE_GUEST = "/workspace";

  if (!sandboxControl) {
    throw new Error("sandboxControl 未初始化");
  }

  await sandboxControl.gitPush({
    proxyId,
    runId: String(run?.id ?? ""),
    instanceName,
    branch: opts.branch,
    cwd: "/workspace",
    env,
  });
}

const wsGateway = createWebSocketGateway({
  prisma,
  attachments,
  sandboxGitPush,
  log: (msg, extra) => server.log.debug(extra ? { ...extra, msg } : { msg }),
});
wsGateway.init(server);

startGitHubPollingLoop({
  prisma,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});

const acpTunnel = createAcpTunnel({
  prisma,
  sendToAgent: wsGateway.sendToAgent,
  broadcastToClients: wsGateway.broadcastToClients,
  sandboxGitPush,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});
wsGateway.setAcpTunnelHandlers(acpTunnel.gatewayHandlers);
wsGateway.setAcpTunnel(acpTunnel);

sandboxControl = createSandboxControlClient({
  sendToAgent: wsGateway.sendToAgent,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});
wsGateway.setSandboxControlHandlers(sandboxControl.handlers);

const createWorkspace: CreateWorkspace = async ({
  runId,
  baseBranch,
  name,
}: {
  runId: string;
  baseBranch: string;
  name: string;
}) => {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { issue: { include: { project: true } }, agent: true },
  });
  const project = (run as any)?.issue?.project;
  if (!project) {
    throw new Error("Run 对应的 Project 不存在");
  }

  const branchName = defaultRunBranchName(name);
  const resolvedBase = String(baseBranch ?? "").trim() || String(project.defaultBranch ?? "main");
  return {
    workspaceMode: "clone",
    workspacePath: "/workspace",
    branchName,
    baseBranch: resolvedBase,
    gitAuthMode: resolveGitAuthMode({
      repoUrl: String(project.repoUrl ?? ""),
      scmType: project.scmType ?? null,
      gitAuthMode: project.gitAuthMode ?? null,
      githubAccessToken: project.githubAccessToken ?? null,
      gitlabAccessToken: project.gitlabAccessToken ?? null,
    }),
    timingsMs: { totalMs: 0 },
  };
};

const pm = createPmAutomation({
  prisma,
  acp: acpTunnel,
  createWorkspace,
  log: (msg, extra) => server.log.info(extra ? { ...extra, msg } : { msg }),
});
server.register(
  makeIssueRoutes({
    prisma,
    acp: acpTunnel,
    createWorkspace,
    onIssueCreated: pm.triggerAutoStart,
  }),
  {
    prefix: "/api/issues",
  },
);
server.register(
  makeRunRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    acp: acpTunnel,
    broadcastToClients: wsGateway.broadcastToClients,
    attachments,
    sandboxGitPush,
  }),
  { prefix: "/api/runs" },
);
server.register(
  makeApprovalRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    createWorkspace,
    broadcastToClients: wsGateway.broadcastToClients,
    sandboxGitPush,
  }),
  { prefix: "/api/approvals" },
);
server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });
server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });
server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });
server.register(makePolicyRoutes({ prisma }), { prefix: "/api" });
server.register(makeWorkflowTemplateRoutes({ prisma }), { prefix: "/api" });
server.register(makeGitHubIssueRoutes({ prisma, onIssueUpserted: pm.triggerAutoStart }), {
  prefix: "/api/projects",
});
server.register(
  makeGitHubWebhookRoutes({
    prisma,
    acp: acpTunnel,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    onIssueUpserted: pm.triggerAutoStart,
    broadcastToClients: wsGateway.broadcastToClients,
    sandboxGitPush,
  }),
  { prefix: "/api/webhooks" },
);
server.register(
  makeGitLabWebhookRoutes({
    prisma,
    webhookSecret: env.GITLAB_WEBHOOK_SECRET,
    onIssueUpserted: pm.triggerAutoStart,
    broadcastToClients: wsGateway.broadcastToClients,
    sandboxGitPush,
  }),
  { prefix: "/api/webhooks" },
);
server.register(
  makeCodeupWebhookRoutes({
    prisma,
    webhookSecret: env.CODEUP_WEBHOOK_SECRET,
    broadcastToClients: wsGateway.broadcastToClients,
  }),
  { prefix: "/api/webhooks" },
);
server.register(
  makeMessageInboundRoutes({
    prisma,
    webhookSecret: env.MESSAGE_WEBHOOK_SECRET,
    onIssueUpserted: pm.triggerAutoStart,
  }),
  { prefix: "/api/integrations" },
);
server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });
server.register(
  makeTaskRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    createWorkspace,
    broadcastToClients: wsGateway.broadcastToClients,
    sandboxGitPush,
  }),
  { prefix: "/api" },
);
server.register(
  makeStepRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    createWorkspace,
    autoDispatch: true,
    broadcastToClients: wsGateway.broadcastToClients,
    sandboxGitPush,
  }),
  { prefix: "/api" },
);
server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });
server.register(
  makeAcpSessionRoutes({
    prisma,
    sendToAgent: wsGateway.sendToAgent,
    acp: acpTunnel,
    createWorkspace,
    broadcastToClients: wsGateway.broadcastToClients,
    auth,
    sandboxGitPush,
  }),
  { prefix: "/api/admin" },
);
server.register(makeSandboxRoutes({ prisma, sendToAgent: wsGateway.sendToAgent, auth }), {
  prefix: "/api/admin",
});
server.register(makeSkillRoutes({ prisma, auth, skillsCli, packages: skillPackages }), { prefix: "/api/admin" });
server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });
server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });
server.register(makeAcpProxyRoutes({ bootstrapToken: env.ACP_PROXY_BOOTSTRAP_TOKEN }), {
  prefix: "/api/admin/acp-proxy",
});
server.register(makeSkillPackageRoutes({ packages: skillPackages }), { prefix: "/api/acp-proxy" });

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
server.setNotFoundHandler(async (request, reply) => {
  const url = String(request.url ?? "");
  const pathOnly = url.split("?")[0] ?? url;
  if (pathOnly.startsWith("/api/")) {
    reply.code(404).send({ success: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
    return;
  }

  // Do not serve index.html for missing static assets, otherwise browsers will refuse to execute
  // module scripts due to MIME mismatch and the app becomes a blank page.
  const looksLikeStaticAsset =
    pathOnly.startsWith("/assets/") ||
    pathOnly === "/favicon.ico" ||
    pathOnly === "/vite.svg" ||
    /\.[a-z0-9]+$/i.test(pathOnly);
  if (looksLikeStaticAsset) {
    reply.code(404).type("text/plain; charset=utf-8").send("静态资源不存在");
    return;
  }

  if (frontendRoot && "sendFile" in reply) {
    reply.sendFile("index.html");
    return;
  }
  reply
    .code(404)
    .type("text/plain; charset=utf-8")
    .send(
      "前端静态文件缺失：无法直连 SPA 路由（例如 /sessions/<id>）。\n" +
        "请运行 `pnpm -C frontend dev` 并访问 Vite（默认 5173），或构建并确保存在 frontend/dist/index.html（或 backend/public/index.html）。",
    );
});

await server.listen({ port: env.PORT, host: env.HOST });

