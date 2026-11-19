import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LoadingRow from "./LoadingRow";

describe("LoadingRow", () => {
  it("is a polite status that screen readers announce", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<LoadingRow label="Loading PDF…" />);
    const status = host.querySelector("[role=status]");
    expect(status).not.toBeNull();
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(status!.textContent).toBe("Loading PDF…");
  });
});
