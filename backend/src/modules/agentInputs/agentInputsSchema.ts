import path from "node:path";

import { z } from "zod";

function assertRelativePosixPath(p: string): void {
  const raw = String(p ?? "").replaceAll("\\", "/").trim();
  if (raw === "") return;
  if (raw.startsWith("/")) throw new Error("target.path must be relative");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === "") return;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("target.path must not escape root");
  }
}

const agentInputsTargetSchema = z
  .object({
    root: z.enum(["WORKSPACE", "USER_HOME"]),
    path: z.string(),
  })
  .superRefine((target, ctx) => {
    try {
      assertRelativePosixPath(target.path);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: String(err) });
    }
  });

const agentInputsSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hostPath"), path: z.string().min(1) }),
  z.object({
    type: z.literal("httpZip"),
    uri: z.string().min(1),
    contentHash: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("inlineText"), text: z.string() }),
]);

const agentInputsItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().max(80).optional(),
    apply: z.enum(["bindMount", "downloadExtract", "writeFile", "copy"]),
    access: z.enum(["ro", "rw"]).optional(),
    source: agentInputsSourceSchema,
    target: agentInputsTargetSchema,
  })
  .superRefine((item, ctx) => {
    if (item.apply === "bindMount") {
      if (item.source.type !== "hostPath") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bindMount requires source.type=hostPath",
          path: ["source"],
        });
      }
      if (item.target.root !== "WORKSPACE") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bindMount target.root must be WORKSPACE",
          path: ["target", "root"],
        });
      }
      const targetPath = String(item.target.path ?? "").replaceAll("\\", "/").trim();
      if (targetPath && targetPath !== ".") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bindMount target.path must be empty or '.'",
          path: ["target", "path"],
        });
      }
    }

    if (item.apply === "downloadExtract" && item.source.type !== "httpZip") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "downloadExtract requires source.type=httpZip",
        path: ["source"],
      });
    }

    if (item.apply === "writeFile" && item.source.type !== "inlineText") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "writeFile requires source.type=inlineText",
        path: ["source"],
      });
    }

    if (item.apply === "copy" && item.source.type !== "hostPath") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "copy requires source.type=hostPath",
        path: ["source"],
      });
    }
  });

export const agentInputsManifestV1Schema = z.object({
  version: z.literal(1),
  envPatch: z
    .object({
      HOME: z.string().optional(),
      USER: z.string().optional(),
      LOGNAME: z.string().optional(),
    })
    .strict()
    .optional(),
  items: z.array(agentInputsItemSchema),
});

export type AgentInputsManifestV1 = z.infer<typeof agentInputsManifestV1Schema>;

export function normalizeAgentInputs(raw: unknown): AgentInputsManifestV1 | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return agentInputsManifestV1Schema.parse(raw);
}
