import { beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import MarksPanel from "./MarksPanel";
import type { Mark } from "../../lib/redact/model";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const marks: Mark[] = [
  { id: "a", kind: "area", page: 1, rect: [0, 0, 10, 10] },
  { id: "b", kind: "search", page: 1, rect: [0, 20, 10, 10], query: "SMITH" },
];

describe("MarksPanel", () => {
  it("shows the selected mark with aria-pressed, an ink outline and a check, not a tint", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <MarksPanel
          marks={marks}
          page={1}
          onPage={() => {}}
          selectedId="b"
          onSelect={() => {}}
          onRemove={() => {}}
          onClear={() => {}}
          canUndo
          canRedo={false}
          onUndo={() => {}}
          onRedo={() => {}}
          wholePage={false}
          onToggleWholePage={() => {}}
          fill="black"
          onFill={() => {}}
          removeMetadata
          onRemoveMetadata={() => {}}
          locked={false}
        />,
      ),
    );
    const rows = [...host.querySelectorAll<HTMLElement>("[data-mark-row]")];
    expect(rows).toHaveLength(2);
    const pick = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(rows.map((r) => pick(r).getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(rows[1].className).toMatch(/\boutline-2\b/);
    expect(rows[1].className).toMatch(/\boutline-ink\b/);
    expect(rows[1].querySelector("svg.lucide-check")).not.toBeNull();
    expect(rows[0].className).not.toMatch(/\boutline-2\b/);
    expect(rows[0].querySelector("svg.lucide-check")).toBeNull();
    // Hover never looks like the selection: no ink outline or fill on hover.
    expect(rows[0].innerHTML).not.toMatch(/hover:(outline|bg-ink)/);
    // Every control keeps the shared focus ring.
    for (const b of host.querySelectorAll("button")) expect(b.className).toContain("focus-visible:ring-2");
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    act(() => root.unmount());
  });
});
