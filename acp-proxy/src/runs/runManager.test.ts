import { describe, expect, it } from "vitest";

import { RunManager } from "./runManager.js";

describe("proxy/runs/RunManager", () => {
  it("serializes per-run ops", async () => {
    const rm = new RunManager({ now: () => 0 });
    const order: string[] = [];

    const run = rm.getOrCreate({ runId: "r1", instanceName: "i1", keepaliveTtlSeconds: 1800 });

    await Promise.all([
      rm.enqueue(run.runId, async () => {
        order.push("a");
      }),
      rm.enqueue(run.runId, async () => {
        order.push("b");
      }),
    ]);

    expect(order).toEqual(["a", "b"]);
  });
});
