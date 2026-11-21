import { describe, expect, it } from "vitest";
import { cellButton, dangerButton, focusRing, inputClass, noticeClass, panelClass, primaryButton, primaryButtonLarge, secondaryButton, smallButton } from "./ui";

describe("shared UI class constants", () => {
  const all = { primaryButton, primaryButtonLarge: primaryButtonLarge(), primaryButtonLargeOnInk: primaryButtonLarge(true), secondaryButton, dangerButton, inputClass, panelClass, noticeClass, smallButton, focusRing };
  for (const [name, value] of Object.entries(all)) {
    it(`${name} has a visible focus ring with offset`, () => {
      expect(value).toContain("focus-visible:ring-2");
      expect(value).toContain("ring-offset");
    });
  }
});

describe("card action bar cells", () => {
  it("draw their focus ring inset, so neighbours and overflow-hidden cards cannot cover it", () => {
    expect(cellButton).toContain("focus-visible:ring-inset");
    expect(cellButton).toContain("focus-visible:!ring-offset-0");
  });
});
