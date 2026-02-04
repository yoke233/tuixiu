import { describe, expect, it, vi } from "vitest";
import { apiGet } from "@/api/client";

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

  it("dedupes refresh when concurrent 401", async () => {
    let healthCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/refresh")) {
        refreshCalls += 1;
        return Promise.resolve(ok({ success: true, data: { ok: true } }, 200));
      }
      if (url.includes("/health")) {
        healthCalls += 1;
        if (healthCalls <= 2) {
          return Promise.resolve(ok({ success: false, error: { code: "UNAUTHORIZED", message: "未登录" } }, 401));
        }
        return Promise.resolve(ok({ success: true, data: { ok: true } }, 200));
      }
      return Promise.resolve(ok({ success: true, data: {} }, 200));
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const [res1, res2] = await Promise.all([apiGet<{ ok: true }>("/health"), apiGet<{ ok: true }>("/health")]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(refreshCalls).toBe(1);

    vi.unstubAllGlobals();
  });
});
