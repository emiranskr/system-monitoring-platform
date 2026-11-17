import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { cn } from "./lib/cn";

describe("iskelet", () => {
  it("App ana basligi ile render eder", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Sistem İzleme" })).toBeInTheDocument();
  });

  it("cn: kosullu siniflari birlestirir, cakisan Tailwind siniflarinda sonuncu kazanir", () => {
    expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
    expect(cn("text-text-primary", undefined, "font-semibold")).toBe("text-text-primary font-semibold");
  });
});
