import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(await screen.findByText("暂无匹配技能。")).toBeInTheDocument();

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

  it("can import a skills.sh search result", async () => {
    const jsonRes = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    (globalThis.fetch as any).mockImplementation(async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = String(init?.method ?? "GET").toUpperCase();

      if (u.pathname.endsWith("/api/admin/skills/import") && method === "POST") {
        return jsonRes({
          success: true,
          data: {
            mode: "new-skill",
            source: {
              sourceType: "skills.sh",
              sourceKey: "vercel-labs/agent-skills@vercel-react-best-practices",
              sourceRef: "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices",
              owner: "vercel-labs",
              repo: "agent-skills",
              skill: "vercel-react-best-practices",
              githubRepoUrl: "https://github.com/vercel-labs/agent-skills",
              skillDir: "skills/vercel-react-best-practices",
            },
            meta: { name: "vercel-react-best-practices", description: null, tags: [] },
            contentHash: "h1",
            fileCount: 1,
            totalBytes: 123,
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/skills/search") && method === "GET") {
        const provider = u.searchParams.get("provider") ?? "registry";
        const q = u.searchParams.get("q") ?? "";

        if (provider === "skills.sh" && q === "react") {
          return jsonRes({
            success: true,
            data: {
              provider: "skills.sh",
              items: [
                {
                  skillId: "external:skills.sh:vercel-labs/agent-skills@vercel-react-best-practices",
                  name: "vercel-react-best-practices",
                  description: null,
                  tags: [],
                  installed: false,
                  latestVersion: null,
                  installs: 1234,
                  sourceType: "skills.sh",
                  sourceKey: "vercel-labs/agent-skills@vercel-react-best-practices",
                  sourceRef: "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices",
                  githubRepoUrl: "https://github.com/vercel-labs/agent-skills",
                  skillDir: "skills/vercel-react-best-practices",
                },
              ],
              nextCursor: null,
            },
          });
        }

        return jsonRes({ success: true, data: { provider, items: [], nextCursor: null } });
      }

      return jsonRes({ success: true, data: { ok: true } });
    });

    render(
      <SkillsSection active reloadToken={0} requireAdmin={() => true} setError={() => undefined} />,
    );

    await userEvent.click(await screen.findByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "skills.sh" }));

    await userEvent.type(await screen.findByPlaceholderText("关键词（skills.sh）"), "react");
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));

    const row = await screen.findByText("vercel-react-best-practices");
    const listItem = row.closest("li");
    expect(listItem).toBeTruthy();

    const importBtn = within(listItem as HTMLElement).getByRole("button", { name: "导入" });
    await userEvent.click(importBtn);

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/skills/import"),
        expect.objectContaining({ method: "POST" }),
      ),
    );

    expect(await screen.findByText(/导入成功/)).toBeInTheDocument();
  });
});
