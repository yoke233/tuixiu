import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { IssuesSection } from "@/pages/admin/sections/IssuesSection";

const { createIssue } = vi.hoisted(() => ({ createIssue: vi.fn() }));

vi.mock("@/api/issues", () => ({
  createIssue,
}));

vi.mock("@/api/githubIssues", () => ({
  importGitHubIssue: vi.fn(),
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}${loc.hash}`}</div>;
}

describe("IssuesSection post-create actions", () => {
  beforeEach(() => {
    createIssue.mockReset();
  });

  it("navigates to /issues after clicking 提交", async () => {
    createIssue.mockResolvedValueOnce({
      issue: { id: "i1", title: "T1" },
      run: undefined,
    });

    render(
      <MemoryRouter initialEntries={["/admin?section=issues"]}>
        <Routes>
          <Route
            path="/admin"
            element={
              <>
                <LocationProbe />
                <IssuesSection
                  active
                  effectiveProject={null}
                  effectiveProjectId="p1"
                  requireAdmin={() => true}
                  setError={() => undefined}
                  onRefreshGlobal={async () => undefined}
                />
              </>
            }
          />
          <Route path="/issues" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Issue 标题"), { target: { value: "T1" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("stays on /admin and clears fields after clicking 保存并继续提交", async () => {
    createIssue.mockResolvedValueOnce({
      issue: { id: "i1", title: "T1" },
      run: undefined,
    });

    render(
      <MemoryRouter initialEntries={["/admin?section=issues"]}>
        <Routes>
          <Route
            path="/admin"
            element={
              <>
                <LocationProbe />
                <IssuesSection
                  active
                  effectiveProject={null}
                  effectiveProjectId="p1"
                  requireAdmin={() => true}
                  setError={() => undefined}
                  onRefreshGlobal={async () => undefined}
                />
              </>
            }
          />
          <Route
            path="/issues"
            element={
              <>
                <LocationProbe />
                <div>HOME</div>
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Issue 标题"), { target: { value: "T1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并继续提交" }));

    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("loc").textContent).toContain("/admin?section=issues");
    expect(screen.getByLabelText("Issue 标题")).toHaveValue("");

    createIssue.mockResolvedValueOnce({
      issue: { id: "i2", title: "T2" },
      run: undefined,
    });
    fireEvent.change(screen.getByLabelText("Issue 标题"), { target: { value: "T2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并继续提交" }));
    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("loc").textContent).toContain("/admin?section=issues");
  });
});
