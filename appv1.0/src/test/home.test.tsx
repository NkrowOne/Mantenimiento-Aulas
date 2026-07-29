import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("Home", () => {
  it("muestra el título de la aplicación", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: /mantenimiento de aulas y salas/i }),
    ).toBeInTheDocument();
  });
});
