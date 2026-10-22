import { fontUrl, isFontFileName, parseManifest, type FontManifest } from "./manifest";

export type Fetcher = (url: string) => Promise<Response>;

export interface FontLoader {
  /** The parsed fonts.json, fetched once. */
  manifest(): Promise<FontManifest>;
  /** The bytes of one font file, fetched on first use and then kept. */
  font(file: string): Promise<Uint8Array>;
}

/**
 * Lazy, deduplicated fetching of the self-hosted fonts. Only bare file names under /fonts-runtime/
 * are requested (same origin). A failed fetch is forgotten so the next call retries; the browser's
 * HTTP cache keeps the files across sessions.
 */
export function createFontLoader(fetcher: Fetcher = (url) => fetch(url)): FontLoader {
  const fonts = new Map<string, Promise<Uint8Array>>();
  let manifest: Promise<FontManifest> | undefined;

  const get = async (file: string): Promise<Response> => {
    const res = await fetcher(fontUrl(file));
    if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
    return res;
  };

  return {
    manifest() {
      manifest ??= get("fonts.json")
        .then(async (res) => parseManifest(await res.json()))
        .catch((e: unknown) => {
          manifest = undefined;
          throw e;
        });
      return manifest;
    },
    font(file) {
      if (!isFontFileName(file)) return Promise.reject(new Error(`Invalid font file name: ${file}`));
      let pending = fonts.get(file);
      if (!pending) {
        pending = get(file)
          .then(async (res) => {
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.byteLength === 0) throw new Error(`Font ${file} is empty`);
            return bytes;
          })
          .catch((e: unknown) => {
            fonts.delete(file);
            throw e;
          });
        fonts.set(file, pending);
      }
      return pending;
    },
  };
}
