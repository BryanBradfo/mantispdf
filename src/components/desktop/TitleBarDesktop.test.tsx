import { beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import TitleBar from "./TitleBar";
import { BANNED_COLOR_PATTERN } from "../../styles/rawColors";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    close: () => Promise.resolve(),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
  }),
}));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("TitleBar in the desktop shell", () => {
  it("is drawn on the tokens with the mantis head, monochrome window controls and a visible focus ring", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<TitleBar />));
    const bar = host.querySelector<HTMLElement>("[data-tauri-drag-region]")!;
    expect(bar.className).toMatch(/\bborder-line\b/);
    expect(bar.className).toMatch(/\bbg-paper\b/);
    expect(host.querySelector('svg[fill="currentColor"]')).not.toBeNull();
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Close window", "Minimize window", "Maximize window"]);
    for (const b of buttons) expect(b.className).toContain("focus-visible:ring-2");
    expect(BANNED_COLOR_PATTERN.test(host.innerHTML)).toBe(false);
    expect(host.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    act(() => root.unmount());
  });
});
