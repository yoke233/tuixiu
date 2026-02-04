import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "@/api/client";

function mockFetchOnce(body: unknown, init?: { status?: number; statusText?: string }) {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? "OK";
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "content-type": "application/json" }
    })
  );
}

describe("apiRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns data when success=true", async () => {
    vi.stubGlobal("fetch", vi.fn());
    mockFetchOnce({ success: true, data: { hello: "world" } });

    const data = await apiRequest<{ hello: string }>("/ping");
    expect(data.hello).toBe("world");
  });

  it("throws when success=false even if HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn());
    mockFetchOnce({ success: false, error: { code: "X", message: "nope" } });

    await expect(apiRequest("/ping")).rejects.toThrow(/nope/);
  });

  it("throws with HTTP status when response not ok", async () => {
    vi.stubGlobal("fetch", vi.fn());
    mockFetchOnce({ success: false, error: { code: "X", message: "boom" } }, { status: 500, statusText: "ERR" });

    await expect(apiRequest("/ping")).rejects.toThrow(/HTTP 500/);
  });
});

