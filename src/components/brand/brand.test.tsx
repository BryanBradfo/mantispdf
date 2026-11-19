import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MantisHead } from "./MantisHead";
import { MantisMark } from "./MantisMark";

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(ui: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(ui));
  return host;
}

const cases = [
  { name: "MantisHead", Component: MantisHead, maxPathBytes: 40_000 },
  { name: "MantisMark", Component: MantisMark, maxPathBytes: 90_000 },
];

describe.each(cases)("$name", ({ Component, maxPathBytes }) => {
  it("is a decorative currentColor svg without a title", () => {
    const svgs = mount(<Component className="h-8 w-8" />).querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.querySelector("title")).toBeNull();
    expect(svg.getAttribute("class")).toBe("h-8 w-8");
  });

  it("is an img with a <title> when titled", () => {
    const svg = mount(<Component title="MantisPDF" />).querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.querySelector("title")?.textContent).toBe("MantisPDF");
  });

  it("keeps the traced path data within budget", () => {
    const d = mount(<Component />).querySelector("path")!.getAttribute("d")!;
    expect(d.length).toBeGreaterThan(1000);
    expect(d.length).toBeLessThan(maxPathBytes);
  });
});
