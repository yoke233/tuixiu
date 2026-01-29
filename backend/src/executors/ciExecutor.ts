import type { PrismaDeps } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";

export async function startCiExecution(deps: { prisma: PrismaDeps }, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { step: true, task: true },
  });
  if (!run) throw new Error("Run 不存在");

  const taskId = (run as any).taskId as string | null;
  const stepId = (run as any).stepId as string | null;
  if (!taskId || !stepId) return;

  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId,
        source: "system",
        type: "ci.waiting",
        payload: { taskId, stepId } as any,
      },
    })
    .catch(() => {});
}

