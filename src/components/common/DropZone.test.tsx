import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, Suspense, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider, loadLocale, localeFromPath } from "../../i18n";
import DropZone from "./DropZone";

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function render(ui: ReactNode, path = "/merge") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await loadLocale(localeFromPath(path)).catch(() => {});
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={null}>
          <LocaleProvider>{ui}</LocaleProvider>
        </Suspense>
      </MemoryRouter>,
    );
  });
}

const zone = () => host.querySelector("label")!;
const overlay = () => document.querySelector<HTMLElement>('[data-testid="page-drop-overlay"]');
const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

/** A drag event as the browser sends it: `types` lists "Files" when files are dragged. */
function drag(type: string, target: EventTarget, { types = ["Files"], files = [] as File[] } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types, files, dropEffect: "none" } });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

describe("DropZone", () => {
  it("is one tab stop: the file input, named by the button text and the drop line", async () => {
    await render(<DropZone multiple onFiles={() => {}} error={null} />);
    const focusable = zone().querySelectorAll("button, a, input, select, textarea, [tabindex], [role=button]");
    expect(focusable).toHaveLength(1);
    expect(focusable[0]).toBe(zone().querySelector('input[type="file"]'));
    expect(zone().textContent).toContain("Choose PDF files");
    expect(zone().textContent).toContain("or drop them here");
    expect(zone().textContent).toContain("PDF files");
  });

  it("says one file, images, and the tool's real size limit", async () => {
    await render(
      <>
        <DropZone onFile={() => {}} error={null} maxMb={64} />
        <DropZone kind="image" multiple onFiles={() => {}} error={null} hint="JPG, PNG" />
        <DropZone kind="image" onFile={() => {}} error={null} />
      </>,
    );
    const [one, images, image] = Array.from(host.querySelectorAll("label")).map((l) => l.textContent);
    expect(one).toContain("Choose a PDF file");
    expect(one).toContain("or drop it here");
    expect(one).toContain("PDF files · up to 64 MB");
    expect(images).toContain("Choose images");
    expect(images).toContain("JPG, PNG");
    expect(image).toContain("Choose an image");
  });

  it("speaks French", async () => {
    await render(<DropZone multiple onFiles={() => {}} error={null} maxMb={64} />, "/fr/merge");
    expect(zone().textContent).toContain("Choisir des fichiers PDF");
    expect(zone().textContent).toContain("ou déposez-les ici");
    expect(zone().textContent).toContain("Fichiers PDF · jusqu’à 64 Mo");
  });

  it("keeps the compact frame as it was (one line, no big button)", async () => {
    await render(<DropZone compact multiple onFiles={() => {}} error={null} />);
    expect(zone().querySelector('[data-testid="drop-button"]')).toBeNull();
    expect(zone().textContent).toContain("Drop your PDFs here or browse");
    expect(zone().className).toContain("py-5");
    expect(zone().className).not.toContain("min-h-");
  });

  it("opens the picker on Enter", async () => {
    await render(<DropZone onFile={() => {}} error={null} />);
    const input = zone().querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("drop anywhere on the page", () => {
  it("shows the overlay on a files drag, not on a text drag, and hides it on leave and Escape", async () => {
    await render(<DropZone multiple onFiles={() => {}} error={null} />);
    expect(overlay()?.dataset.visible).toBeUndefined();

    drag("dragenter", document.body, { types: ["text/plain"] });
    expect(overlay()?.dataset.visible).toBeUndefined();

    drag("dragenter", document.body);
    expect(overlay()?.dataset.visible).toBe("true");
    // Crossing into a child: enter fires before the parent's leave. No flicker.
    drag("dragenter", host);
    drag("dragleave", document.body);
    expect(overlay()?.dataset.visible).toBe("true");
    drag("dragleave", host);
    expect(overlay()?.dataset.visible).toBeUndefined();

    drag("dragenter", document.body);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(overlay()?.dataset.visible).toBeUndefined();
  });

  it("hands files dropped on the overlay to the zone", async () => {
    const onFiles = vi.fn();
    await render(<DropZone multiple onFiles={onFiles} error={null} />);
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    drag("dragenter", document.body);
    const drop = drag("drop", overlay()!, { files });
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(overlay()?.dataset.visible).toBeUndefined();
  });

  it("gives a single-file zone the first file, and a drop on the zone itself is not handled twice", async () => {
    const onFile = vi.fn();
    await render(<DropZone onFile={onFile} error={null} />);
    drag("drop", overlay()!, { files: [pdf("a.pdf"), pdf("b.pdf")] });
    expect(onFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "a.pdf" }));
    onFile.mockClear();
    drag("drop", zone(), { files: [pdf("c.pdf")] });
    expect(onFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "c.pdf" }));
  });

  it("is off while the engine is not ready, and when no zone is mounted", async () => {
    await render(<DropZone onFile={() => {}} error={null} engineReady={false} />);
    expect(overlay()).toBeNull();
    act(() => root!.unmount());
    root = null;
    expect(overlay()).toBeNull();
  });

  it("with two zones (Compare): no overlay, both light up, each takes its own drop, the page feeds the first", async () => {
    const a = vi.fn();
    const b = vi.fn();
    await render(
      <>
        <DropZone onFile={a} error={null} />
        <DropZone onFile={b} error={null} />
      </>,
    );
    const [zoneA, zoneB] = Array.from(host.querySelectorAll("label"));
    expect(overlay()).toBeNull();

    drag("dragenter", document.body, { types: ["text/plain"] });
    expect(zoneA.dataset.dragging).toBeUndefined();
    drag("dragenter", document.body);
    expect(zoneA.dataset.dragging).toBe("true");
    expect(zoneB.dataset.dragging).toBe("true");

    drag("drop", zoneB, { files: [pdf("b.pdf")] });
    expect(b).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "b.pdf" }));
    expect(a).not.toHaveBeenCalled();
    expect(zoneA.dataset.dragging).toBeUndefined();
    expect(zoneB.dataset.dragging).toBeUndefined();

    drag("dragenter", document.body);
    drag("drop", document.body, { files: [pdf("a.pdf")] });
    expect(a).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "a.pdf" }));
    expect(b).toHaveBeenCalledOnce();
  });

  it("goes back to the full-page overlay when only one zone is left", async () => {
    let fill: () => void = () => {};
    function Two() {
      const [both, setBoth] = useState(true);
      fill = () => setBoth(false);
      return (
        <>
          {both && <DropZone onFile={() => {}} error={null} />}
          <DropZone onFile={() => {}} error={null} />
        </>
      );
    }
    await render(<Two />);
    expect(overlay()).toBeNull();
    act(() => fill());
    expect(overlay()).not.toBeNull();
  });
});
