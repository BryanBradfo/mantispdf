import { describe, it, expect, beforeAll, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { LocaleProvider, loadLocale } from "../i18n";
import type { PlannerAction } from "../hooks/usePagePlanner";
import { usePlannerUpload } from "./usePlannerUpload";

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await loadLocale("fr");
});

describe("usePlannerUpload", () => {
  it("keeps a pending upload when the language changes", async () => {
    let finishCount: ((n: number) => void) | null = null;
    const worker = {
      ready: true,
      initError: null,
      countPages: () => new Promise<number>((resolve) => (finishCount = resolve)),
    };
    const dispatch = vi.fn<(a: PlannerAction) => void>();
    let addFiles: (files: File[]) => Promise<void> = async () => {};
    let go: (path: string) => void = () => {};
    function Harness() {
      addFiles = usePlannerUpload(worker, dispatch).addFiles;
      const navigate = useNavigate();
      go = (path) => void navigate(path);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/organize"]}>
          <Suspense fallback={null}>
            <LocaleProvider>
              <Harness />
            </LocaleProvider>
          </Suspense>
        </MemoryRouter>,
      );
    });

    await act(async () => {
      void addFiles([new File([new Uint8Array([37, 80, 68, 70])], "a.pdf", { type: "application/pdf" })]);
    });
    // The file is read asynchronously before the engine is asked for its page count.
    await vi.waitFor(() => expect(finishCount).not.toBeNull());
    await act(async () => go("/fr/organize"));
    await act(async () => finishCount!(3));

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "sources-added" }));
    act(() => root.unmount());
  });
});
