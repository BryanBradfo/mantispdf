import { describe, it, expect, beforeAll, vi } from "vitest";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { LocaleProvider } from "../i18n";
import EncryptPdfPage from "./EncryptPdfPage";

const encryptPdf = vi.fn();
vi.mock("../hooks/usePdfWorker", () => ({
  usePdfWorker: () => ({ ready: true, initProblem: null, encrypting: false, encryptPdf }),
}));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("EncryptPdfPage", () => {
  it("marks a confirm password that does not match as aria-invalid with a danger border and message", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <HelmetProvider>
          <MemoryRouter initialEntries={["/encrypt"]}>
            <Suspense fallback={null}>
              <LocaleProvider>
                <EncryptPdfPage />
              </LocaleProvider>
            </Suspense>
          </MemoryRouter>
        </HelmetProvider>,
      );
    });
    const file = new File([new Uint8Array([37, 80, 68, 70])], "a.pdf", { type: "application/pdf" });
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));

    const [password, confirm] = host.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(confirm.getAttribute("aria-invalid")).toBe("false");
    expect(confirm.className).not.toMatch(/border-danger/);

    await act(async () => {
      type(password, "secret");
      type(confirm, "other");
    });
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Encrypt PDF")!.click());

    expect(encryptPdf).not.toHaveBeenCalled();
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(confirm.className).toMatch(/!border-danger/);
    const message = host.querySelector(".text-danger");
    expect(message?.textContent).toBe("Passwords do not match.");
    expect(confirm.getAttribute("aria-describedby")).toBe(message?.id);

    // Typing again clears the error.
    await act(async () => type(confirm, "secret"));
    expect(confirm.getAttribute("aria-invalid")).toBe("false");
    expect(host.querySelector(".text-danger")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
