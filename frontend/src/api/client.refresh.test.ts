import { describe, expect, it, vi } from "vitest";
import { apiGet } from "./client";

function ok(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiRequest refresh", () => {
  it("retries once after 401 by calling /auth/refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ success: false, error: { code: "UNAUTHORIZED", message: "未登录" } }, 401))
      .mockResolvedValueOnce(ok({ success: true, data: { ok: true } }, 200))
      .mockResolvedValueOnce(ok({ success: true, data: { ok: true } }, 200));

    vi.stubGlobal("fetch", fetchMock as any);

    const res = await apiGet<{ ok: true }>("/health");
    expect(res.ok).toBe(true);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/auth/refresh"))).toBe(true);

    vi.unstubAllGlobals();
  });
});
