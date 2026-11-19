import { createFontLoader } from "./loader";
import { fontUrl } from "./manifest";

/** The main thread's font loader (the manifest; the worker keeps its own for the font bytes). */
export const pageFonts = createFontLoader();

/** CSS family name under which a font file is registered for the editor preview. */
export function fontFaceFamily(file: string): string {
  return `mantis-${file.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

const registered = new Map<string, Promise<void>>();

/**
 * Registers `file` (same origin, /fonts-runtime/) as a FontFace for SVG text and waits until it is
 * loaded. The browser HTTP cache shares the bytes with the worker's fetch.
 */
export function ensureFontFace(file: string): Promise<void> {
  let pending = registered.get(file);
  if (!pending) {
    const face = new FontFace(fontFaceFamily(file), `url("${fontUrl(file)}")`);
    pending = face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
      })
      .catch((e: unknown) => {
        registered.delete(file);
        throw e;
      });
    registered.set(file, pending);
  }
  return pending;
}
