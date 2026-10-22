import { describe, expect, it, vi } from "vitest";
import { createFontLoader } from "./loader";
import type { FontManifest } from "./manifest";

const manifest: FontManifest = { version: 1, fonts: [{ file: "A_400Regular.ttf", family: "A", weight: 400, size: 3, ranges: [[0x20, 0x7e]] }] };
const SFNT = [0, 1, 0, 0];
const bytes = (n: number[]) => new Response(new Uint8Array(n));

describe("createFontLoader", () => {
  it("fetches the manifest once and parses it", async () => {
    const fetcher = vi.fn(async () => Response.json(manifest));
    const loader = createFontLoader(fetcher);
    const [a, b] = await Promise.all([loader.manifest(), loader.manifest()]);
    expect(a).toEqual(manifest);
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/fonts-runtime/fonts.json");
  });

  it("fetches a font lazily, once, even for concurrent callers", async () => {
    const fetcher = vi.fn(async () => bytes([...SFNT, 1, 2, 3]));
    const loader = createFontLoader(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([loader.font("A_400Regular.ttf"), loader.font("A_400Regular.ttf")]);
    expect([...a]).toEqual([...SFNT, 1, 2, 3]);
    expect(b).toBe(a);
    await loader.font("A_400Regular.ttf");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/fonts-runtime/A_400Regular.ttf");
  });

  it("does not cache a failure: the next call retries", async () => {
    const fetcher = vi.fn<(u: string) => Promise<Response>>().mockResolvedValueOnce(new Response("no", { status: 404 })).mockResolvedValueOnce(bytes([...SFNT, 9]));
    const loader = createFontLoader(fetcher);
    await expect(loader.font("A_400Regular.ttf")).rejects.toThrow(/404|A_400Regular/);
    expect([...(await loader.font("A_400Regular.ttf"))]).toEqual([...SFNT, 9]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty body, a network error and a file name that is a path", async () => {
    const loader = createFontLoader(async () => bytes([]));
    await expect(loader.font("A_400Regular.ttf")).rejects.toThrow(/empty/i);
    const down = createFontLoader(async () => { throw new TypeError("offline"); });
    await expect(down.font("A_400Regular.ttf")).rejects.toThrow(/offline/);
    await expect(loader.font("../secret")).rejects.toThrow(/file name/i);
    await expect(loader.font("https://evil.example/x.ttf")).rejects.toThrow(/file name/i);
  });

  it("accepts every sfnt signature and rejects anything else, without caching it", async () => {
    for (const sig of ["true", "OTTO", "ttcf"]) {
      const ok = createFontLoader(async () => new Response(new TextEncoder().encode(`${sig}xx`)));
      expect((await ok.font("A_400Regular.ttf")).byteLength).toBe(6);
    }
    const fetcher = vi.fn<(u: string) => Promise<Response>>().mockResolvedValueOnce(new Response("<!doctype html><html></html>")).mockResolvedValueOnce(bytes([...SFNT, 1]));
    const loader = createFontLoader(fetcher);
    await expect(loader.font("A_400Regular.ttf")).rejects.toThrow(/not a font/i);
    expect((await loader.font("A_400Regular.ttf")).byteLength).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("forgets the manifest on failure too", async () => {
    const fetcher = vi.fn<(u: string) => Promise<Response>>().mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(Response.json(manifest));
    const loader = createFontLoader(fetcher);
    await expect(loader.manifest()).rejects.toThrow(/500/);
    expect(await loader.manifest()).toEqual(manifest);
  });
});
