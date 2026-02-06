import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RolesSection } from "@/pages/admin/sections/RolesSection";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RolesSection Agent 文件", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows backend validation errors without losing local edits", async () => {
    (globalThis.fetch as any).mockImplementation(async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = String(init?.method ?? "GET").toUpperCase();

      if (u.pathname.endsWith("/api/projects/p1/roles") && method === "GET") {
        return jsonRes({
          success: true,
          data: {
            roles: [
              {
                id: "r1",
                projectId: "p1",
                key: "dev",
                displayName: "Dev",
                description: "",
                promptTemplate: "",
                initScript: "",
                initTimeoutSeconds: 300,
                agentInputs: null,
                envKeys: [],
                createdAt: "2026-02-02T00:00:00.000Z",
                updatedAt: "2026-02-02T00:00:00.000Z",
              },
            ],
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/projects/p1/roles/r1/skills") && method === "GET") {
        return jsonRes({ success: true, data: { projectId: "p1", roleId: "r1", items: [] } });
      }

      if (u.pathname.endsWith("/api/projects/p1/roles/r1") && method === "PATCH") {
        return jsonRes(
          {
            success: false,
            error: {
              code: "BAD_REQUEST",
              message: "参数校验失败",
              details: [
                {
                  path: ["agentInputs", "items", 0, "target", "path"],
                  message: "target.path must not escape root",
                },
              ],
            },
          },
          400,
        );
      }

      return jsonRes({ success: true, data: { ok: true } });
    });

    render(
      <RolesSection
        active
        effectiveProjectId="p1"
        requireAdmin={() => true}
        setError={() => undefined}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /dev/i }));
    expect(await screen.findByText("Agent 文件")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Agent 文件/i }));
    await userEvent.click(screen.getByRole("button", { name: "新增" }));

    const textArea = (await screen.findByLabelText(
      "source.inlineText.text",
    )) as HTMLTextAreaElement;
    await userEvent.type(textArea, "hello");

    const targetPath = screen.getByLabelText(/target\.path/i) as HTMLInputElement;
    await userEvent.clear(targetPath);
    await userEvent.type(targetPath, "../escape.txt");

    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 文件" }));

    expect(await screen.findByText(/Agent 文件保存失败/)).toBeInTheDocument();
    expect(await screen.findByText(/target\.path must not escape root/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(
        (screen.getByLabelText("source.inlineText.text") as HTMLTextAreaElement).value,
      ).toContain("hello");
    });
  });

  it("copy-to-create leaves key empty and copies other fields", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    (globalThis.fetch as any).mockImplementation(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = new URL(String(url));
      const method = String(init?.method ?? "GET").toUpperCase();

      if (u.pathname.endsWith("/api/projects/p1/roles") && method === "GET") {
        return jsonRes({
          success: true,
          data: {
            roles: [
              {
                id: "r1",
                projectId: "p1",
                key: "dev",
                displayName: "Dev",
                description: "desc",
                promptTemplate: "prompt",
                initScript: "echo hi",
                initTimeoutSeconds: 123,
                agentInputs: {
                  version: 1,
                  items: [
                    {
                      id: "x",
                      apply: "writeFile",
                      source: { type: "inlineText", text: "t" },
                      target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
                    },
                  ],
                },
                envKeys: [],
                envText: "FOO=bar",
                createdAt: "2026-02-02T00:00:00.000Z",
                updatedAt: "2026-02-02T00:00:00.000Z",
              },
            ],
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/projects/p1/roles/r1/skills") && method === "GET") {
        return jsonRes({
          success: true,
          data: {
            projectId: "p1",
            roleId: "r1",
            items: [
              {
                skillId: "s1",
                name: "Demo",
                versionPolicy: "latest",
                pinnedVersionId: null,
                enabled: true,
              },
            ],
          },
        });
      }

      if (u.pathname.endsWith("/api/projects/p1/roles") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body.key).toBe("dev-copy");
        expect(body.displayName).toBe("Dev");
        expect(body.description).toBe("desc");
        expect(body.promptTemplate).toBe("prompt");
        expect(body.initScript).toBe("echo hi");
        expect(body.initTimeoutSeconds).toBe(123);
        expect(body.agentInputs?.version).toBe(1);
        return jsonRes({
          success: true,
          data: {
            role: {
              id: "r2",
              projectId: "p1",
              key: "dev-copy",
              displayName: "Dev",
              description: "desc",
              promptTemplate: "prompt",
              initScript: "echo hi",
              initTimeoutSeconds: 123,
              agentInputs: body.agentInputs ?? null,
              envKeys: [],
              envText: null,
              createdAt: "2026-02-02T00:00:00.000Z",
              updatedAt: "2026-02-02T00:00:00.000Z",
            },
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/projects/p1/roles/r2/skills") && method === "PUT") {
        return jsonRes({ success: true, data: { projectId: "p1", roleId: "r2", items: [] } });
      }

      return jsonRes({ success: true, data: { ok: true } });
    });

    render(
      <RolesSection
        active
        effectiveProjectId="p1"
        requireAdmin={() => true}
        setError={() => undefined}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /dev/i }));
    await userEvent.click(await screen.findByRole("button", { name: "复制为新角色" }));

    expect(await screen.findByText("创建 RoleTemplate")).toBeInTheDocument();

    const roleKey = screen.getByPlaceholderText("backend-dev") as HTMLInputElement;
    expect(roleKey.value).toBe("");

    const displayName = screen.getByPlaceholderText("后端开发") as HTMLInputElement;
    expect(displayName.value).toBe("Dev");

    await userEvent.type(roleKey, "dev-copy");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.url.includes("/api/projects/p1/roles") &&
            String(c.init?.method ?? "GET").toUpperCase() === "POST",
        ),
      ).toBe(true);
    });
  });
  it("uses target.path filename when old item name is code letter", async () => {
    (globalThis.fetch as any).mockImplementation(async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = String(init?.method ?? "GET").toUpperCase();

      if (u.pathname.endsWith("/api/projects/p1/roles") && method === "GET") {
        return jsonRes({
          success: true,
          data: {
            roles: [
              {
                id: "r1",
                projectId: "p1",
                key: "dev",
                displayName: "Dev",
                description: "",
                promptTemplate: "",
                initScript: "",
                initTimeoutSeconds: 300,
                agentInputs: {
                  version: 1,
                  items: [
                    {
                      id: "x",
                      name: "code A",
                      apply: "writeFile",
                      source: { type: "inlineText", text: "t" },
                      target: { root: "USER_HOME", path: ".codex/rules/Alpha.md" },
                    },
                  ],
                },
                envKeys: [],
                createdAt: "2026-02-02T00:00:00.000Z",
                updatedAt: "2026-02-02T00:00:00.000Z",
              },
            ],
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/projects/p1/roles/r1/skills") && method === "GET") {
        return jsonRes({ success: true, data: { projectId: "p1", roleId: "r1", items: [] } });
      }

      return jsonRes({ success: true, data: { ok: true } });
    });

    render(
      <RolesSection
        active
        effectiveProjectId="p1"
        requireAdmin={() => true}
        setError={() => undefined}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /dev/i }));

    expect(await screen.findByText("Alpha.md")).toBeInTheDocument();
    expect(await screen.findByText("编辑：Alpha.md")).toBeInTheDocument();
  });

  it("updates name and target filename after choosing inline text file", async () => {
    (globalThis.fetch as any).mockImplementation(async (url: any, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = String(init?.method ?? "GET").toUpperCase();

      if (u.pathname.endsWith("/api/projects/p1/roles") && method === "GET") {
        return jsonRes({
          success: true,
          data: {
            roles: [
              {
                id: "r1",
                projectId: "p1",
                key: "dev",
                displayName: "Dev",
                description: "",
                promptTemplate: "",
                initScript: "",
                initTimeoutSeconds: 300,
                agentInputs: { version: 1, items: [] },
                envKeys: [],
                createdAt: "2026-02-02T00:00:00.000Z",
                updatedAt: "2026-02-02T00:00:00.000Z",
              },
            ],
          },
        });
      }

      if (u.pathname.endsWith("/api/admin/projects/p1/roles/r1/skills") && method === "GET") {
        return jsonRes({ success: true, data: { projectId: "p1", roleId: "r1", items: [] } });
      }

      return jsonRes({ success: true, data: { ok: true } });
    });

    const { container } = render(
      <RolesSection
        active
        effectiveProjectId="p1"
        requireAdmin={() => true}
        setError={() => undefined}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /dev/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Agent 文件/i }));
    await userEvent.click(screen.getByRole("button", { name: "新增" }));

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    if (!fileInput) return;

    const file = new File(["# from file\n"], "MyPolicy.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => "# from file\n" });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect((screen.getByLabelText("名称（可选）") as HTMLInputElement).value).toBe("MyPolicy.md");
      expect((screen.getByLabelText(/target\.path/i) as HTMLInputElement).value).toBe(
        ".codex/MyPolicy.md",
      );
    });
  });
});
