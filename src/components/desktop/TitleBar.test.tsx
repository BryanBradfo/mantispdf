import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TitleBar from "./TitleBar";

describe("TitleBar", () => {
  it("renders nothing outside the Tauri desktop shell", () => {
    // jsdom has no `__TAURI_INTERNALS__`, so isTauri() is false. The web app
    // must not show fake desktop window controls.
    expect(renderToStaticMarkup(<TitleBar />)).toBe("");
  });
});
