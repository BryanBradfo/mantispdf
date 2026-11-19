import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Toolbar, { type Tool } from "./Toolbar";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

/** A bare (not hover: or focus:) utility class. */
const bare = (cls: string) => new RegExp(`(?:^|\\s)${cls}(?:\\s|$)`);

function render(tool: Tool, canUndo = false) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <Toolbar tool={tool} onTool={() => {}} onPickImage={() => {}} canUndo={canUndo} canRedo={false} onUndo={() => {}} onRedo={() => {}} />,
  );
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  return { host, buttons, pressed: buttons.filter((b) => b.getAttribute("aria-pressed") === "true") };
}

describe("editor Toolbar", () => {
  it("marks exactly the active tool with aria-pressed and the ink fill", () => {
    const { buttons, pressed } = render("rect");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("aria-label")).toBe("Rectangle (R)");
    expect(pressed[0].className).toMatch(bare("bg-ink"));
    expect(pressed[0].className).toMatch(bare("text-paper"));
    const idle = buttons.find((b) => b.getAttribute("aria-label") === "Select (V)")!;
    expect(idle.getAttribute("aria-pressed")).toBe("false");
    expect(idle.className).not.toMatch(bare("bg-ink"));
  });

  it("follows the active tool", () => {
    expect(render("select").pressed[0].getAttribute("aria-label")).toBe("Select (V)");
    expect(render("whiteout").pressed[0].getAttribute("aria-label")).toBe("Whiteout (W)");
  });

  it("draws an inset focus ring (the buttons sit edge to edge) and flips it to paper on the ink-filled tool", () => {
    const { pressed, buttons } = render("text");
    for (const b of buttons) {
      expect(b.className).toMatch(/focus-visible:ring-2/);
      expect(b.className).toMatch(/focus-visible:ring-inset/);
    }
    expect(pressed[0].className).toMatch(/focus-visible:!ring-paper/);
  });

  it("uses theme tokens only, and disables undo and redo when there is nothing to undo", () => {
    const { host, buttons } = render("draw");
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    const undo = buttons.find((b) => b.getAttribute("aria-label") === "Undo (Ctrl+Z)")!;
    expect(undo.disabled).toBe(true);
    expect(render("draw", true).buttons.find((b) => b.getAttribute("aria-label") === "Undo (Ctrl+Z)")!.disabled).toBe(false);
  });
});
