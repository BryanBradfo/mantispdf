import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SelectGrid from "./SelectGrid";
import { initialPlannerState, type PlannerState } from "../../hooks/usePagePlanner";

const state = (selected: string[]): PlannerState => ({
  ...initialPlannerState,
  items: [
    { id: "a", kind: "blank" },
    { id: "b", kind: "blank" },
  ],
  selected: new Set(selected),
});

function cards(mode: "remove" | "extract", selected: string[]) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<SelectGrid state={state(selected)} dispatch={() => {}} mode={mode} />);
  return [...host.querySelectorAll("button")].map((button) => ({
    pressed: button.getAttribute("aria-pressed"),
    card: button.querySelector<HTMLElement>("[data-testid=planner-card]")!,
  }));
}

describe("SelectGrid selection reads without colour", () => {
  it("marks a picked page with aria-pressed, a 2 px ink outline and a check badge", () => {
    const [picked, plain] = cards("extract", ["a"]);
    expect(picked.pressed).toBe("true");
    expect(picked.card.className).toMatch(/\boutline-2\b/);
    expect(picked.card.className).toMatch(/\boutline-ink\b/);
    expect(picked.card.querySelector("svg.lucide-check")).not.toBeNull();

    expect(plain.pressed).toBe("false");
    expect(plain.card.className).not.toMatch(/\boutline-2\b/);
    expect(plain.card.querySelector("svg.lucide-check")).toBeNull();
  });

  it("marks a page to remove with aria-pressed, a 2 px outline and a cross badge, never a raw colour", () => {
    const [removed, kept] = cards("remove", ["a"]);
    expect(removed.pressed).toBe("true");
    expect(removed.card.className).toMatch(/\boutline-2\b/);
    expect(removed.card.querySelector("svg.lucide-x")).not.toBeNull();
    expect(removed.card.outerHTML).not.toMatch(/\b(?:red|green|mantis)-\d/);

    expect(kept.pressed).toBe("false");
    expect(kept.card.className).not.toMatch(/\boutline-2\b/);
  });
});
