import { describe, expect, it } from "vitest";
import { dangerButton, focusRing, inputClass, noticeClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";

describe("ToolShell class constants", () => {
  const all = { primaryButton, secondaryButton, dangerButton, inputClass, panelClass, noticeClass, focusRing };
  for (const [name, value] of Object.entries(all)) {
    it(`${name} has a visible focus ring with offset`, () => {
      expect(value).toContain("focus-visible:ring-2");
      expect(value).toContain("ring-offset");
    });
  }
});
