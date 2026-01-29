import { z } from "zod";

export const gateDecisionDecisionSchema = z.enum(["PASS", "CONCERNS", "FAIL", "WAIVED"]);
export type GateDecisionDecision = z.infer<typeof gateDecisionDecisionSchema>;

export const gateDecisionSchema = z.object({
  kind: z.literal("gate_decision"),
  version: z.number().int().positive().default(1),

  gate: z.string().min(1), // e.g. "implementation_readiness" | "review" | "release"
  decision: gateDecisionDecisionSchema,

  reasons: z.array(z.string().min(1)).default([]),
  requiredActions: z.array(z.string().min(1)).default([]),
  evidence: z
    .array(
      z.object({
        type: z.string().min(1), // e.g. "pr" | "ci_result" | "report" | "link"
        ref: z.string().min(1),
        note: z.string().min(1).optional(),
      }),
    )
    .default([]),

  createdAt: z.string().min(1).optional(),
});

export type GateDecision = z.infer<typeof gateDecisionSchema>;

export function parseGateDecision(content: unknown): GateDecision | null {
  const parsed = gateDecisionSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

