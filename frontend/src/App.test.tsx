import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./pages/IssueListPage", () => ({
  IssueListPage: () => (
    <div>
      IssueListPage
      <Outlet />
    </div>
  )
}));
vi.mock("./pages/IssueDetailPage", () => ({
  IssueDetailPage: () => <div>IssueDetailPage</div>
}));

import App from "./App";

describe("App routes", () => {
  it("redirects / to /issues", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("IssueListPage")).toBeInTheDocument());
  });

  it("renders issue detail route", async () => {
    render(
      <MemoryRouter initialEntries={["/issues/i1"]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("IssueDetailPage")).toBeInTheDocument());
  });
});
