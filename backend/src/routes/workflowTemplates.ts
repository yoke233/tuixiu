import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../db.js";
import { taskTemplateOverridesSchema } from "../modules/workflow/taskTemplateResolver.js";
import { getTaskTemplatesForProject, setTaskTemplatesForProject } from "../modules/workflow/taskTemplatePolicy.js";

export function makeWorkflowTemplateRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/workflow-templates", async (request) => {
      const querySchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = querySchema.parse(request.query);
      return await getTaskTemplatesForProject({ prisma: deps.prisma }, projectId);
    });

    server.put("/workflow-templates", async (request) => {
      const querySchema = z.object({ projectId: z.string().uuid() });
      const bodySchema = z.object({ taskTemplates: taskTemplateOverridesSchema });
      const { projectId } = querySchema.parse(request.query);
      const body = bodySchema.parse(request.body ?? {});

      return await setTaskTemplatesForProject({ prisma: deps.prisma }, { projectId, taskTemplates: body.taskTemplates });
    });
  };
}
