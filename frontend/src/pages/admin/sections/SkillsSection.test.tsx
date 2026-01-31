import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillsSection } from "./SkillsSection";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("SkillsSection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders empty hint after initial search", async () => {
    mockFetchJsonOnce({ success: true, data: { provider: "registry", items: [], nextCursor: null } });

    render(
      <SkillsSection active reloadToken={0} requireAdmin={() => true} setError={() => undefined} />,
    );

    expect(
      await screen.findByText("暂无匹配技能。若这是首次使用，请先导入/入库 skills（后续迭代提供上传/同步能力）。"),
    ).toBeInTheDocument();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
  });

  it("opens detail panel when clicking an item", async () => {
    const skillId = "00000000-0000-0000-0000-000000000001";

    mockFetchJsonOnce({
      success: true,
      data: {
        provider: "registry",
        items: [
          {
            skillId,
            name: "demo-skill",
            description: "desc",
            tags: ["tag1"],
            installed: true,
            latestVersion: { versionId: "v1", contentHash: "h1", importedAt: "2026-01-01T00:00:00.000Z" },
          },
        ],
        nextCursor: null,
      },
    });

    mockFetchJsonOnce({
      success: true,
      data: {
        skill: {
          id: skillId,
          name: "demo-skill",
          description: "desc",
          tags: ["tag1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    mockFetchJsonOnce({
      success: true,
      data: {
        skillId,
        versions: [
          { id: "v1", contentHash: "h1", storageUri: null, source: null, importedAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
    });

    render(
      <SkillsSection active reloadToken={0} requireAdmin={() => true} setError={() => undefined} />,
    );

    expect(await screen.findByText("demo-skill")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /demo-skill/i }));

    expect(await screen.findByText("Skill ID")).toBeInTheDocument();
    expect((await screen.findAllByText(skillId)).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("h1")).toBeInTheDocument();
  });
});
