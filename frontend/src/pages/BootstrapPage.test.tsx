import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AuthProvider } from "../auth/AuthProvider";
import { ThemeProvider } from "../theme";
import { BootstrapPage } from "./BootstrapPage";

describe("BootstrapPage", () => {
  it("renders bootstrap token input", () => {
    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter>
            <BootstrapPage />
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );
    expect(screen.getByLabelText("Bootstrap Token")).toBeInTheDocument();
  });
});
