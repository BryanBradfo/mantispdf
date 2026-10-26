import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../../i18n";
import ProgressOverlay from "./ProgressOverlay";

let root: Root;
let host: HTMLDivElement;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function percentAt(path: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>
            <ProgressOverlay progress={0.42} message="x" error={null} onDismissError={() => {}} />
          </LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
  return host.querySelector("p.text-right")?.textContent;
}

describe("ProgressOverlay percentage", () => {
  it("is formatted for the locale", async () => {
    expect(await percentAt("/merge")).toBe("42%");
    expect(await percentAt("/fr/merge")).toBe("42\u00a0%");
  });
});
