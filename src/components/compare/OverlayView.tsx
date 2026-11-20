import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { formatNumber, useLocale, useT } from "../../i18n";
import { createPixelDiffer } from "../../lib/compare/pixelClient";
import { entryDiffers, overlayEntries, overlayRenderWidth, pairGrid, percentParts, visibleEntries, type OverlayEntry, type PageResult } from "../../lib/compare/overlay";
import { OverlayEngine, type Lane, type ScanState } from "../../lib/compare/overlayEngine";
import {
  abortError,
  canvasFrom,
  isAbort,
  onWhite,
  openOverlayDoc,
  pixelsOf,
  release,
  renderBoth,
  renderPage,
  sameSize,
  type OverlayDoc,
} from "../../lib/compare/overlayRender";
import type { Size } from "../../lib/compare/view";
import { COMPARE_PIXEL, COMPARE_PIXEL_RGBA, COMPARE_SWATCH_PAGE, pageBadge } from "../../styles/onPage";
import { checkClass, focusRing, monoLabel, noticeClass, smallButton } from "../../styles/ui";

interface Props {
  fileA: File;
  fileB: File;
  /** Page sizes in visible orientation (rotation applied), as the text view uses them. */
  sizesA: readonly Size[];
  sizesB: readonly Size[];
}

type Docs = { status: "opening" } | { status: "ready"; a: OverlayDoc; b: OverlayDoc } | { status: "error" };

/**
 * The mask of a pair on the fixed compute grid (`canvas`, grid size) and the widths the two pages
 * took on it, so the display renders can be laid out the same way at screen resolution.
 */
interface GridOverlay {
  canvas: HTMLCanvasElement;
  widthA: number;
  widthB: number;
}

/** What the stage shows: a pair (display renders + grid mask), a page from one document only, or a failure. */
type Shown =
  | { status: "loading"; page: number }
  | { status: "pair"; page: number; a: HTMLCanvasElement; b: HTMLCanvasElement; overlay: GridOverlay; ratio: number }
  | { status: "single"; page: number; side: "a" | "b"; canvas: HTMLCanvasElement }
  | { status: "error"; page: number };

const NO_RESULTS: ReadonlyMap<number, PageResult> = new Map();
const IDLE: ScanState = { status: "idle" };

/** Give the main thread back between two scanned pages. */
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 0);
  });

/** Shows a canvas made elsewhere (no copy): it is moved into this box and scaled to its width (or to the box with `fill`). */
function CanvasHost({ canvas, className = "", testId, fill = false }: { canvas: HTMLCanvasElement; className?: string; testId?: string; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = fill ? "100%" : "auto";
    el.replaceChildren(canvas);
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas);
    };
  }, [canvas, fill]);
  return <div ref={ref} aria-hidden="true" data-testid={testId} className={className} />;
}

function Spinner() {
  return <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent motion-reduce:animate-none" />;
}

/**
 * The overlay view: page pair i diffed on a fixed compute grid (same result on every screen), the
 * pages drawn at screen resolution with the grid's mask scaled over the modified one; a page list
 * with the share of changed pixels once known, and a filter that checks every page. Remounted for
 * new documents (the caller keys it); unmounting cancels it all.
 */
export default function OverlayView({ fileA, fileB, sizesA, sizesB }: Props) {
  const t = useT("compare");
  const locale = useLocale();
  const entries = useMemo(() => overlayEntries(sizesA.length, sizesB.length), [sizesA.length, sizesB.length]);
  const [docs, setDocs] = useState<Docs>({ status: "opening" });
  const [engine, setEngine] = useState<OverlayEngine<GridOverlay> | null>(null);
  const [page, setPage] = useState(1);
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [shown, setShown] = useState<Shown>({ status: "loading", page: 1 });
  const [cssWidth, setCssWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  // One pdf.js document per file for the life of the view.
  useEffect(() => {
    let alive = true;
    const opened: OverlayDoc[] = [];
    const open = (f: File) =>
      openOverlayDoc(f).then((d) => {
        if (alive) opened.push(d);
        else void d.destroy();
        return d;
      });
    Promise.all([open(fileA), open(fileB)]).then(
      ([a, b]) => alive && setDocs({ status: "ready", a, b }),
      () => alive && setDocs({ status: "error" }),
    );
    return () => {
      alive = false;
      for (const doc of opened) void doc.destroy();
    };
  }, [fileA, fileB]);

  // The engine: page pairs rendered on the fixed grid and diffed in a worker per lane (stage, scan).
  useEffect(() => {
    if (docs.status !== "ready") return;
    const differs = { stage: createPixelDiffer(), scan: createPixelDiffer() };
    const compute = async (n: number, lane: Lane, signal: AbortSignal) => {
      const grid = pairGrid(sizesA[n - 1] ?? [0, 0], sizesB[n - 1] ?? [0, 0]);
      const [ra, rb] = await renderBoth(
        () => renderPage(docs.a, n, grid.widthA, signal),
        () => renderPage(docs.b, n, grid.widthB, signal),
      );
      const widthA = ra.width;
      const widthB = rb.width;
      // Same size for the diff: the smaller page padded with white (a taller page really differs there).
      const [a, b] = sameSize(ra, rb);
      const w = a.width;
      const h = a.height;
      let pa, pb;
      try {
        pa = pixelsOf(a);
        pb = pixelsOf(b);
      } finally {
        release(a, b);
      }
      const d = await differs[lane].diff(pa, pb, COMPARE_PIXEL_RGBA);
      if (signal.aborted) throw abortError();
      return { ratio: d.ratio, overlay: { canvas: canvasFrom(d.overlay, w, h), widthA, widthB } };
    };
    const e = new OverlayEngine<GridOverlay>({
      compute,
      resetLane: (lane) => differs[lane].reset(),
      release: (o) => release(o.canvas),
      idle,
    });
    setEngine(e);
    return () => {
      e.dispose();
      differs.stage.dispose();
      differs.scan.dispose();
      setEngine(null);
    };
  }, [docs, sizesA, sizesB]);

  const subscribe = useMemo(() => (engine ? engine.subscribe : () => () => {}), [engine]);
  const results = useSyncExternalStore(subscribe, () => engine?.getResults() ?? NO_RESULTS);
  const scan = useSyncExternalStore(subscribe, () => engine?.getScan() ?? IDLE);

  // Width of the modified page on screen: the display renders follow it (stepped); the diff does not.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // Hidden (the text view is on show) it measures 0: keep the last width so nothing re-renders.
    const measure = () => {
      if (el.clientWidth > 0) setCssWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const px = cssWidth > 0 ? overlayRenderWidth(cssWidth, typeof window === "undefined" ? 1 : window.devicePixelRatio) : 0;

  const entry: OverlayEntry | undefined = entries[page - 1];

  // The page on stage, when picked (lazily): its grid diff from the engine, then both pages drawn at
  // screen resolution in the grid's layout. A new pick or a resize supersedes it.
  useEffect(() => {
    if (docs.status !== "ready" || !engine || !entry || px === 0) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    setShown({ status: "loading", page: entry.page });
    const run = async (): Promise<Shown> => {
      if (entry.kind !== "pair") {
        const side = entry.kind === "only-a" ? "a" : "b";
        const canvas = await engine.pauseWhile(() => renderPage(docs[side], entry.page, px, signal));
        return { status: "single", page: entry.page, side, canvas };
      }
      const { ratio, overlay } = await engine.stage(entry.page);
      if (signal.aborted) throw abortError();
      const k = px / overlay.canvas.width;
      const h = Math.max(1, Math.round(overlay.canvas.height * k));
      const [da, db] = await engine.pauseWhile(() =>
        renderBoth(
          () => renderPage(docs.a, entry.page, Math.max(1, Math.round(overlay.widthA * k)), signal),
          () => renderPage(docs.b, entry.page, Math.max(1, Math.round(overlay.widthB * k)), signal),
        ),
      );
      const a = onWhite(da, px, h);
      const b = onWhite(db, px, h);
      release(da, db);
      return { status: "pair", page: entry.page, a, b, overlay, ratio };
    };
    run().then(
      (next) => {
        if (signal.aborted) {
          if (next.status === "pair") release(next.a, next.b);
          else if (next.status === "single") release(next.canvas);
          return;
        }
        setShown(next);
      },
      (e: unknown) => {
        if (signal.aborted || isAbort(e)) return;
        setShown({ status: "error", page: entry.page });
      },
    );
    return () => ctrl.abort();
  }, [docs, engine, entry, px]);

  // Free the display canvases of a page once another one replaces it (the engine owns the masks).
  useEffect(() => {
    return () => {
      if (shown.status === "pair") release(shown.a, shown.b);
      else if (shown.status === "single") release(shown.canvas);
    };
  }, [shown]);

  // The filter checks every page pair in the engine (shared cache, known pages skipped).
  useEffect(() => {
    if (!onlyDifferent || !engine) return;
    engine.startScan(entries.filter((e) => e.kind === "pair").map((e) => e.page));
    return () => engine.stopScan();
  }, [onlyDifferent, engine, entries]);

  const listed = visibleEntries(entries, results, onlyDifferent);
  const differing = entries.filter((e) => entryDiffers(e, results) === true).length;

  const pct = (ratio: number) => {
    const { value, below } = percentParts(ratio);
    const s = formatNumber(value, locale, { style: "percent", maximumFractionDigits: 1 });
    return below ? t("lessThan", { percent: s }) : s;
  };
  /** The badge of a page in the list: its text and whether it marks a difference (ink) or not (grey). */
  const badgeOf = (e: OverlayEntry): { text: string; differs: boolean; failed?: boolean } | null => {
    if (e.kind === "only-a") return { text: t("onlyInA"), differs: false };
    if (e.kind === "only-b") return { text: t("onlyInB"), differs: false };
    const r = results.get(e.page);
    if (r?.status === "done") return { text: pct(r.ratio), differs: r.ratio > 0 };
    if (r?.status === "error") return { text: "!", differs: true, failed: true };
    return null;
  };

  // With the filter on, a page shown that turns out not to differ gives way to the first one that does.
  useEffect(() => {
    if (!onlyDifferent || listed.length === 0 || !entry) return;
    if (!listed.some((e) => e.page === page) && entryDiffers(entry, results) === false) setPage(listed[0].page);
  }, [onlyDifferent, listed, entry, page, results]);
  // "Page X of N" counts the pages listed (all, or the differing ones with the filter).
  const position = listed.findIndex((e) => e.page === page);

  // Previous / next move through the pages listed (all, or the differing ones with the filter).
  const step = (dir: 1 | -1) => {
    const pagesListed = listed.map((e) => e.page);
    const next = dir === 1 ? pagesListed.find((p) => p > page) : [...pagesListed].reverse().find((p) => p < page);
    if (next !== undefined) setPage(next);
  };
  const hasPrev = listed.some((e) => e.page < page);
  const hasNext = listed.some((e) => e.page > page);

  const summary = (() => {
    if (!entry) return "";
    if (entry.kind === "only-a") return t("pageOnlyA", { page: entry.page });
    if (entry.kind === "only-b") return t("pageOnlyB", { page: entry.page });
    const r = results.get(entry.page);
    if (r?.status === "error") return t("renderFailed", { page: entry.page });
    if (r?.status !== "done") return t("renderingPage", { page: entry.page });
    return r.ratio === 0 ? t("pixelSame", { page: entry.page }) : t("pixelSummary", { page: entry.page, percent: pct(r.ratio) });
  })();

  const stageA = shown.status === "pair" ? shown.a : shown.status === "single" && shown.side === "a" ? shown.canvas : null;
  const stageB = shown.status === "pair" ? shown.b : shown.status === "single" && shown.side === "b" ? shown.canvas : null;
  const onStage = shown.page === entry?.page;
  const pairRatio = shown.status === "pair" && onStage ? shown.ratio : null;

  const pageBox = (side: "a" | "b", canvas: HTMLCanvasElement | null) => {
    const missing = entry && ((side === "a" && entry.kind === "only-b") || (side === "b" && entry.kind === "only-a"));
    return (
      <figure className="flex min-w-0 flex-col">
        <figcaption className={`${monoLabel} mb-2 truncate`}>
          {side === "a" ? `A / ${t("original")}` : `B / ${t("modified")}`}
          <span className="hidden sm:inline"> · {side === "a" ? fileA.name : fileB.name}</span>
        </figcaption>
        <div ref={side === "b" ? stageRef : undefined} className="relative w-full border border-line bg-surface">
          {missing ? (
            <div className={`flex aspect-[8.5/11] items-center justify-center p-4 text-center ${monoLabel}`}>{side === "a" ? t("onlyInB") : t("onlyInA")}</div>
          ) : canvas && onStage ? (
            <div className="relative" style={COMPARE_SWATCH_PAGE} data-testid={`overlay-page-${side}`}>
              <CanvasHost canvas={canvas} />
              {side === "b" && shown.status === "pair" && <CanvasHost canvas={shown.overlay.canvas} fill className="absolute inset-0" testId="overlay-mask" />}
              {side === "b" && pairRatio !== null && (
                <span className={`absolute right-2 top-2 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${pageBadge}`} data-testid="overlay-badge">
                  {pct(pairRatio)}
                </span>
              )}
            </div>
          ) : shown.status === "error" && onStage ? (
            <div className={`flex aspect-[8.5/11] items-center justify-center p-4 text-center ${monoLabel}`}>
              <span aria-hidden="true">!</span>
              <span className="sr-only">{t("drawFailedShort")}</span>
            </div>
          ) : (
            <div className="flex aspect-[8.5/11] items-center justify-center">
              <Spinner />
            </div>
          )}
        </div>
      </figure>
    );
  };

  if (docs.status === "error") {
    return (
      <p className={`mt-6 ${noticeClass}`} role="alert">
        {t("overlayOpenFailed")}
      </p>
    );
  }

  return (
    <div className="mt-6" data-testid="overlay-view">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-b border-line pb-4">
        <div className="flex items-center gap-2">
          <button type="button" className={`${smallButton} h-9 w-9`} onClick={() => step(-1)} disabled={!hasPrev} aria-label={t("previousPage")}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
          </button>
          <p className={`${monoLabel} min-w-[8.5rem] text-center`} data-testid="overlay-page-of">
            {position >= 0 ? t("pageOf", { page: position + 1, total: listed.length }) : t("pageOf", { page, total: entries.length })}
          </p>
          <button type="button" className={`${smallButton} h-9 w-9`} onClick={() => step(1)} disabled={!hasNext} aria-label={t("nextPage")}>
            <ChevronRight aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" className={checkClass} checked={onlyDifferent} onChange={(e) => setOnlyDifferent(e.target.checked)} />
          {t("onlyDifferent")}
        </label>
        <span className={`${monoLabel} flex items-center gap-2`}>
          <span aria-hidden="true" className="relative inline-block h-3 w-6" style={COMPARE_SWATCH_PAGE}>
            <span className="absolute inset-0" style={COMPARE_PIXEL} />
          </span>
          {t("legendPixels")}
        </span>
      </div>

      <p className="mt-4 text-sm text-ink" role="status" aria-live="polite" data-testid="overlay-summary">
        {summary}
      </p>

      <div className="mt-4 grid gap-x-6 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_14rem]">
        <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:contents">
          {pageBox("a", stageA)}
          {pageBox("b", stageB)}
        </div>
        <nav aria-labelledby="overlay-pages-heading" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <h2 id="overlay-pages-heading" className={`${monoLabel} mb-2`}>
            {t("pageList")} · {entries.length}
          </h2>
          {onlyDifferent && (
            <p className={`${monoLabel} mb-2`} data-testid="overlay-scan">
              {scan.status === "running" ? t("scanning", { done: scan.done, total: scan.total }) : t("scanDone", { count: differing })}
            </p>
          )}
          {listed.length === 0 && scan.status !== "running" ? (
            <p className="text-sm text-ink-2">{t("noPageListed")}</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto border border-line lg:max-h-[70vh]" data-testid="overlay-pages">
              {listed.map((e) => {
                const on = e.page === page;
                const badge = badgeOf(e);
                return (
                  <li key={e.page} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setPage(e.page)}
                      aria-current={on ? "page" : undefined}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0 ${
                        on ? "text-ink outline outline-2 -outline-offset-2 outline-ink" : "text-ink hover:bg-surface"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {on && <Check aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5" />}
                        {t("page", { page: e.page })}
                      </span>
                      {badge && (
                        <span className={`font-mono text-[11px] uppercase tracking-[0.08em] ${badge.differs ? "text-ink" : "text-ink-2"}`}>
                          {badge.failed ? (
                            <>
                              <span aria-hidden="true">!</span>
                              <span className="sr-only">{t("drawFailedShort")}</span>
                            </>
                          ) : (
                            badge.text
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>
      <p className="mt-4 text-xs text-ink-2">{t("overlayNote")}</p>
    </div>
  );
}
