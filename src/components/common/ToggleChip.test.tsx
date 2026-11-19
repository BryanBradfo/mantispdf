import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ToggleChip from "./ToggleChip";

const chip = (on: boolean) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ToggleChip on={on} onClick={() => {}}>PNG</ToggleChip>);
  return host.querySelector("button")!;
};

describe("ToggleChip", () => {
  it("says on/off with aria-pressed and fills in ink only when on", () => {
    expect(chip(true).getAttribute("aria-pressed")).toBe("true");
    expect(chip(true).className).toMatch(/\bbg-ink\b/);
    expect(chip(false).getAttribute("aria-pressed")).toBe("false");
    expect(chip(false).className).not.toMatch(/\bbg-ink\b/);
    expect(chip(false).getAttribute("type")).toBe("button");
  });
});
