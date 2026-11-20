import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { formatNumber, useLocale, useT } from "../../i18n";
import { createLatest } from "../../lib/latest";
import { createPixelDiffer, type PixelDiffer } from "../../lib/compare/pixelClient";
import { entryDiffers, overlayEntries, overlayRenderWidth, percentParts, visibleEntries, type OverlayEntry, type PageResult } from "../../lib/compare/overlay";
import { abortError, canvasFrom, isAbort, onWhite, openOverlayDoc, pixelsOf, release, renderPage, type OverlayDoc } from "../../lib/compare/overlayRender";
import { COMPARE_PIXEL, COMPARE_PIXEL_RGBA, COMPARE_SWATCH_PAGE, pageBadge } from "../../styles/onPage";
import { checkClass, focusRing, monoLabel, noticeClass, smallButton } from "../../styles/ui";

interface Props {
  fileA: File;
  fileB: File;
  pagesA: number;
  pagesB: number;
}

type Docs = { status: "opening" } | { status: "ready"; a: OverlayDoc; b: OverlayDoc } | { status: "error" };

/** What the stage shows: a pair with its overlay, a page from one document only, or a failure. */
type Shown =
  | { status: "loading"; page: number }
  | { status: "pair"; page: number; a: HTMLCanvasElement; b: HTMLCanvasElement; overlay: HTMLCanvasElement; ratio: number }
  | { status: "single"; page: number; side: "a" | "b"; canvas: HTMLCanvasElement }
  | { status: "error"; page: number };

type Scan = { status: "idle" } | { status: "running"; done: number; total: number } | { status: "done" };

/** Render page `page` of both documents at `px` wide on same-size white canvases and diff them off the main thread. */
async function computePair(docs: { a: OverlayDoc; b: OverlayDoc }, page: number, px: number, differ: PixelDiffer, signal: AbortSignal) {
  const [ra, rb] = await Promise.all([renderPage(docs.a, page, px, signal), renderPage(docs.b, page, px, signal)]);
  // Same width; the shorter page is padded with white (a taller page really differs there).
  const h = Math.max(ra.height, rb.height);
  const a = onWhite(ra, px, h);
  const b = onWhite(rb, px, h);
  release(ra, rb);
  try {
    const d = await differ.diff(pixelsOf(a), pixelsOf(b), COMPARE_PIXEL_RGBA);
    if (signal.aborted) throw abortError();
    return { a, b, overlay: canvasFrom(d.overlay, px, h), ratio: d.ratio };
  } catch (e) {
    release(a, b);
    throw e;
  }
}

/** Shows a canvas made elsewhere (no copy): it is moved into this box and scaled to its width. */
function CanvasHost({ canvas, className = "", testId }: { canvas: HTMLCanvasElement; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    el.replaceChildren(canvas);
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas);
    };
  }, [canvas]);
  return <div ref={ref} aria-hidden="true" data-testid={testId} className={className} />;
}

function Spinner() {
  return <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent motion-reduce:animate-none" />;
}

/**
 * The overlay view: page pair i drawn at the same width, the pixels that differ painted red over
 * the modified page; a page list (with the share of changed pixels once known) and a filter that
 * checks every page. Remounted for new documents (the caller keys it); unmounting cancels it all.
 */
export default function OverlayView({ fileA, fileB, pagesA, pagesB }: Props) {
  const t = useT("compare");
  const locale = useLocale();
  const entries = useMemo(() => overlayEntries(pagesA, pagesB), [pagesA, pagesB]);
  const [docs, setDocs] = useState<Docs>({ status: "opening" });
  const [differ, setDiffer] = useState<PixelDiffer | null>(null);
  const [results, setResults] = useState<ReadonlyMap<number, PageResult>>(() => new Map());
  const [page, setPage] = useState(1);
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [scan, setScan] = useState<Scan>({ status: "idle" });
  const [shown, setShown] = useState<Shown>({ status: "loading", page: 1 });
  const [cssWidth, setCssWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const shownLatest = useMemo(createLatest, []);
  const scanLatest = useMemo(createLatest, []);

  const record = useCallback((n: number, r: PageResult) => setResults((cur) => new Map(cur).set(n, r)), []);

  // One pdf.js document per file and one pixel worker for the life of the view.
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
    const d = createPixelDiffer();
    setDiffer(d);
    return () => {
      alive = false;
      shownLatest.invalidate();
      scanLatest.invalidate();
      d.dispose();
      for (const doc of opened) void doc.destroy();
    };
  }, [fileA, fileB, shownLatest, scanLatest]);

  // Width of the modified page on screen; renders follow it (stepped, so small resizes keep them).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setCssWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const px = cssWidth > 0 ? overlayRenderWidth(cssWidth, typeof window === "undefined" ? 1 : window.devicePixelRatio) : 0;

  const entry: OverlayEntry | undefined = entries[page - 1];

  // The page on stage: rendered and diffed when it is picked (lazily), superseded by the next pick.
  useEffect(() => {
    if (docs.status !== "ready" || !differ || !entry || px === 0) return;
    const current = shownLatest.begin();
    const ctrl = new AbortController();
    setShown({ status: "loading", page: entry.page });
    const run = async (): Promise<Shown> => {
      if (entry.kind === "pair") {
        const r = await computePair(docs, entry.page, px, differ, ctrl.signal);
        return { status: "pair", page: entry.page, ...r };
      }
      const side = entry.kind === "only-a" ? "a" : "b";
      const canvas = await renderPage(docs[side], entry.page, px, ctrl.signal);
      return { status: "single", page: entry.page, side, canvas };
    };
    run().then(
      (next) => {
        if (!current()) {
          if (next.status === "pair") release(next.a, next.b, next.overlay);
          else if (next.status === "single") release(next.canvas);
          return;
        }
        if (next.status === "pair") record(next.page, { status: "done", ratio: next.ratio });
        setShown(next);
      },
      (e: unknown) => {
        if (!current() || isAbort(e)) return;
        if (entry.kind === "pair") record(entry.page, { status: "error" });
        setShown({ status: "error", page: entry.page });
      },
    );
    return () => ctrl.abort();
  }, [docs, differ, entry, px, shownLatest, record]);

  // Free the canvases of a page once another one replaces it.
  useEffect(() => {
    return () => {
      if (shown.status === "pair") release(shown.a, shown.b, shown.overlay);
      else if (shown.status === "single") release(shown.canvas);
    };
  }, [shown]);

  // The filter checks every page pair not known yet, one at a time, with a progress count.
  useEffect(() => {
    if (!onlyDifferent || docs.status !== "ready" || !differ || px === 0) {
      setScan({ status: "idle" });
      return;
    }
    const current = scanLatest.begin();
    const ctrl = new AbortController();
    const pairs = entries.filter((e) => e.kind === "pair");
    // Pages already computed (shown before) are skipped.
    const known = new Set(results.keys());
    const todo = pairs.filter((e) => !known.has(e.page));
    let done = pairs.length - todo.length;
    setScan(todo.length ? { status: "running", done, total: pairs.length } : { status: "done" });
    void (async () => {
      for (const e of todo) {
        if (!current()) return;
        try {
          const r = await computePair(docs, e.page, px, differ, ctrl.signal);
          release(r.a, r.b, r.overlay);
          if (!current()) return;
          record(e.page, { status: "done", ratio: r.ratio });
        } catch (err) {
          if (!current() || isAbort(err)) return;
          record(e.page, { status: "error" });
        }
        done++;
        setScan(done < pairs.length ? { status: "running", done, total: pairs.length } : { status: "done" });
      }
    })();
    return () => {
      scanLatest.invalidate();
      ctrl.abort();
    };
    // `results` is read once at the start: the scan's own results must not restart it.
  }, [onlyDifferent, docs, differ, px, entries, scanLatest, record]); // eslint-disable-line react-hooks/exhaustive-deps

  const listed = visibleEntries(entries, results, onlyDifferent);
  const differing = entries.filter((e) => entryDiffers(e, results) === true).length;

  const pct = (ratio: number) => {
    const { value, below } = percentParts(ratio);
    const s = formatNumber(value, locale, { style: "percent", maximumFractionDigits: 1 });
    return below ? t("lessThan", { percent: s }) : s;
  };
  const badgeOf = (e: OverlayEntry): string => {
    if (e.kind === "only-a") return t("onlyInA");
    if (e.kind === "only-b") return t("onlyInB");
    const r = results.get(e.page);
    return r?.status === "done" ? pct(r.ratio) : r?.status === "error" ? "!" : "";
  };

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
              {side === "b" && shown.status === "pair" && <CanvasHost canvas={shown.overlay} className="absolute inset-0" testId="overlay-mask" />}
              {side === "b" && pairRatio !== null && (
                <span className={`absolute right-2 top-2 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${pageBadge}`} data-testid="overlay-badge">
                  {pct(pairRatio)}
                </span>
              )}
            </div>
          ) : shown.status === "error" && onStage ? (
            <div className={`flex aspect-[8.5/11] items-center justify-center p-4 text-center ${monoLabel}`}>!</div>
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
        {t("renderFailed", { page })}
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
            {t("pageOf", { page, total: entries.length })}
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
                      {badge && <span className={`font-mono text-[11px] uppercase tracking-[0.08em] ${e.kind === "pair" && badge !== pct(0) ? "text-ink" : "text-ink-2"}`}>{badge}</span>}
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
