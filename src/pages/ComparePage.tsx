import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, TriangleAlert } from "lucide-react";
import { Link, Trans, UserError, useDescribeError, useT, type UiError } from "../i18n";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, readFileAsUint8Array } from "../lib/fileHelpers";
import { pdfjs } from "../lib/pdf";
import { createLatest } from "../lib/latest";
import { createCompareWorker } from "../lib/compare/client";
import { extractWords, type PdfLike } from "../lib/compare/extract";
import type { CompareResult, Word } from "../lib/compare/types";
import { buildAnchors, changeTarget, countWords, highlightMarks, mapPosition, posFromPx, pxFromPos, type Side, type Size } from "../lib/compare/view";
import ErrorAlert from "../components/common/ErrorAlert";
import ChangesList from "../components/compare/ChangesList";
import FileSlot, { type SlotView } from "../components/compare/FileSlot";
import OverlayView from "../components/compare/OverlayView";
import PageColumn from "../components/compare/PageColumn";
import ToggleChip from "../components/common/ToggleChip";
import ToolShell from "./ToolShell";
import { COMPARE_ADDED, COMPARE_REMOVED, COMPARE_STRIKE, COMPARE_SWATCH_PAGE } from "../styles/onPage";
import { linkClass, monoLabel, noticeClass, secondaryButton } from "../styles/ui";

/** Limits per document (spec 6a section 5). */
const MAX_PAGES = 500;
const MAX_MB = 64;
/** Where the scroll sync lines the two columns up: this far down the visible column. */
const SYNC_LINE = 0.3;

type Slot =
  | { kind: "empty"; error: UiError | null }
  | { kind: "reading"; key: number; file: File; progress: { done: number; total: number } | null }
  | { kind: "ready"; key: number; file: File; sizes: Size[]; words: Word[][] };

type Diff =
  | { status: "idle" }
  | { status: "running"; aKey: number; bKey: number }
  | { status: "done"; aKey: number; bKey: number; result: CompareResult };

const EMPTY: Slot = { kind: "empty", error: null };

const warnIcon = <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />;

/** A link to OCR in a new tab: leaving would lose the files picked here. */
const ocrLink = (children: ReactNode) => (
  <Link to="/ocr" target="_blank" rel="noopener" className={linkClass}>
    {children}
  </Link>
);

function slotView(slot: Slot): SlotView {
  if (slot.kind === "empty") return slot;
  if (slot.kind === "reading") return { kind: "reading", file: slot.file, progress: slot.progress };
  return { kind: "ready", file: slot.file, pages: slot.sizes.length };
}

let nextKey = 1;

interface TextViewProps {
  a: Extract<Slot, { kind: "ready" }>;
  b: Extract<Slot, { kind: "ready" }>;
  result: CompareResult;
}

/** The two page columns with their highlights, scrolled together, and the list of changes. */
function TextView({ a, b, result }: TextViewProps) {
  const t = useT("compare");
  const [active, setActive] = useState<number | null>(null);
  const marks = useMemo(() => highlightMarks(result, a.words, b.words), [result, a.words, b.words]);
  const anchors = useMemo(() => buildAnchors(result, a.words, b.words, a.sizes, b.sizes), [result, a.words, b.words, a.sizes, b.sizes]);
  const scroll = { a: useRef<HTMLDivElement>(null), b: useRef<HTMLDivElement>(null) };
  const pages = { a: useRef<(HTMLDivElement | null)[]>([]), b: useRef<(HTMLDivElement | null)[]>([]) };
  // The scrollTop each column was last moved to by the sync: its own scroll event is then ignored.
  const expected = useRef<Record<Side, number | null>>({ a: null, b: null });
  const columnsRef = useRef<HTMLDivElement>(null);

  // Page offsets per column, read once and kept until a column is resized or the documents change
  // (not on every scroll event).
  type Geometry = { tops: number[]; heights: number[] };
  const geometryCache = useRef<Record<Side, Geometry | null>>({ a: null, b: null });
  const geometry = (side: Side): Geometry => {
    const cached = geometryCache.current[side];
    if (cached) return cached;
    const els = pages[side].current.slice(0, (side === "a" ? a : b).sizes.length);
    const g = { tops: els.map((el) => el?.offsetTop ?? 0), heights: els.map((el) => el?.offsetHeight ?? 0) };
    geometryCache.current[side] = g;
    return g;
  };
  useEffect(() => {
    geometryCache.current = { a: null, b: null };
    const els = [scroll.a.current, scroll.b.current].filter((el): el is HTMLDivElement => el !== null);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      geometryCache.current = { a: null, b: null };
    });
    for (const el of els) ro.observe(el);
    return () => ro.disconnect();
  }, [a.sizes, b.sizes]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveTo = (side: Side, top: number) => {
    const el = scroll[side].current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const next = Math.round(Math.max(0, Math.min(max, top)));
    if (Math.abs(el.scrollTop - next) < 1) return;
    el.scrollTop = next;
    expected.current[side] = el.scrollTop;
  };

  const onScroll = (side: Side) => {
    const el = scroll[side].current;
    if (!el) return;
    const want = expected.current[side];
    expected.current[side] = null;
    if (want !== null && Math.abs(el.scrollTop - want) < 2) return;
    const other: Side = side === "a" ? "b" : "a";
    const otherEl = scroll[other].current;
    if (!otherEl) return;
    // At either end, the other column goes to the same end (no text to match above the first line).
    if (el.scrollTop <= 1) return moveTo(other, 0);
    if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) return moveTo(other, otherEl.scrollHeight);
    const from = geometry(side);
    const to = geometry(other);
    const pos = posFromPx(from.tops, from.heights, el.scrollTop + el.clientHeight * SYNC_LINE);
    const mapped = mapPosition(anchors, pos, side === "a" ? "a-to-b" : "b-to-a");
    moveTo(other, pxFromPos(to.tops, to.heights, mapped) - otherEl.clientHeight * SYNC_LINE);
  };
  const onScrollA = useCallback(() => onScroll("a"), [anchors]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScrollB = useCallback(() => onScroll("b"), [anchors]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback(
    (index: number) => {
      setActive(index);
      for (const side of ["a", "b"] as const) {
        const el = scroll[side].current;
        if (!el) continue;
        const doc = side === "a" ? a : b;
        const { tops, heights } = geometry(side);
        const pos = changeTarget(result, index, side, doc.words, doc.sizes);
        moveTo(side, pxFromPos(tops, heights, pos) - el.clientHeight * SYNC_LINE);
      }
      // On narrow screens the list sits under the columns: bring them into view.
      const cols = columnsRef.current;
      if (cols && cols.getBoundingClientRect().top < 0) cols.scrollIntoView({ block: "start" });
    },
    [result, a, b], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // A new result: back to the top, nothing picked.
  useEffect(() => {
    setActive(null);
    for (const side of ["a", "b"] as const) {
      const el = scroll[side].current;
      if (el) el.scrollTop = 0;
      expected.current[side] = null;
    }
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  const { added, removed, changed } = result.stats;
  const total = result.changes.length;
  const sameText = total === 0;

  return (
    <div className="mt-6">
      {result.mode === "per-page" && (
        <p className={`mb-6 flex gap-2 ${noticeClass}`} data-testid="compare-per-page">
          {warnIcon}
          <span>{t("perPage")}</span>
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line pb-4">
        <div>
          <p className="font-display text-4xl font-light leading-none tracking-[-0.01em] text-ink sm:text-5xl" data-testid="compare-headline">
            {sameText ? t("noDifferences") : t("summary", { count: total })}
          </p>
          {!sameText && (
            <p className={`${monoLabel} mt-3`} data-testid="compare-counts">
              {t("addedCount", { count: added })} · {t("removedCount", { count: removed })} · {t("changedCount", { count: changed })}
            </p>
          )}
        </div>
        <div className={`${monoLabel} flex items-center gap-5`} aria-label={t("legendLabel")} role="group">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="relative inline-block h-3 w-6" style={COMPARE_SWATCH_PAGE}>
              <span className="absolute inset-0" style={COMPARE_REMOVED} />
              <span className="absolute inset-x-0 top-1/2 h-[1.5px]" style={COMPARE_STRIKE} />
            </span>
            {t("kindRemoved")}
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="relative inline-block h-3 w-6 p-[3px]" style={COMPARE_SWATCH_PAGE}>
              <span className="block h-full w-full" style={{ ...COMPARE_ADDED, outlineOffset: "-1.5px", outlineWidth: "1.5px" }} />
            </span>
            {t("kindAdded")}
          </span>
        </div>
      </div>
      {sameText && <p className="mt-4 max-w-2xl text-sm text-ink-2">{t("noDifferencesNote")}</p>}

      <div className={`mt-6 grid gap-x-6 gap-y-8 ${sameText ? "" : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_18rem]"}`}>
        <div ref={columnsRef} className={`grid grid-cols-2 gap-3 sm:gap-6 lg:contents ${sameText ? "lg:!grid" : ""}`}>
          <PageColumn
            label={`A / ${t("original")}`}
            fileName={a.file.name}
            regionLabel={t("originalPages")}
            source={a.file}
            sizes={a.sizes}
            marks={marks.a}
            active={active}
            scrollRef={scroll.a}
            pageRefs={pages.a}
            onScroll={onScrollA}
            testId="compare-column-a"
          />
          <PageColumn
            label={`B / ${t("modified")}`}
            fileName={b.file.name}
            regionLabel={t("modifiedPages")}
            source={b.file}
            sizes={b.sizes}
            marks={marks.b}
            active={active}
            scrollRef={scroll.b}
            pageRefs={pages.b}
            onScroll={onScrollB}
            testId="compare-column-b"
          />
        </div>
        {!sameText && (
          <aside aria-labelledby="compare-changes-heading" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <h2 id="compare-changes-heading" className={`${monoLabel} mb-2`}>
              {t("changes")} · {total}
            </h2>
            <div className="lg:max-h-[74vh] lg:overflow-y-auto">
              <ChangesList changes={result.changes} active={active} onPick={pick} />
            </div>
          </aside>
        )}
      </div>
      <p className="mt-4 text-xs text-ink-2">{t("syncNote")}</p>
    </div>
  );
}

export default function ComparePage() {
  const t = useT("compare");
  const tc = useT("common");
  const describe = useDescribeError();
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const [slots, setSlots] = useState<[Slot, Slot]>([EMPTY, EMPTY]);
  const [diff, setDiff] = useState<Diff>({ status: "idle" });
  const [error, setError] = useState<UiError | null>(null);
  const [view, setView] = useState<"text" | "overlay">("text");
  // The overlay mounts on first use and then stays mounted (hidden under the text view) so its cache survives.
  const [overlayUsed, setOverlayUsed] = useState(false);
  // Text extraction per slot key, aborted when its file is removed or replaced.
  const reads = useRef(new Map<number, AbortController>());
  const compareRef = useRef<ReturnType<typeof createCompareWorker> | null>(null);
  const latest = useMemo(createLatest, []);

  useEffect(() => {
    const w = createCompareWorker();
    compareRef.current = w;
    return () => {
      w.dispose();
      if (compareRef.current === w) compareRef.current = null;
    };
  }, []);

  /** Replace the slot that holds `key` (wherever a swap moved it); a slot removed or replaced since is left alone. */
  const settle = useCallback((key: number, next: Slot) => {
    setSlots((cur) => cur.map((s) => (s.kind !== "empty" && s.key === key ? next : s)) as [Slot, Slot]);
  }, []);

  const pick = useCallback(
    async (index: 0 | 1, file: File) => {
      const fail = (e: UiError) => setSlots((cur) => (index === 0 ? [{ kind: "empty", error: e }, cur[1]] : [cur[0], { kind: "empty", error: e }]));
      if (!isPdfFile(file)) return fail(tc("invalidPdf"));
      if (worker.initError) return fail(tc("engineFailedReload"));
      if (!worker.ready) return fail(tc("engineLoading"));
      if (file.size > MAX_MB * 1024 * 1024) return fail(t("tooLarge", { name: file.name, max: MAX_MB }));
      const key = nextKey++;
      const ctrl = new AbortController();
      reads.current.set(key, ctrl);
      setSlots((cur) => {
        // The file it replaces stops being read.
        const old = cur[index];
        if (old.kind === "reading") reads.current.get(old.key)?.abort();
        const next: Slot = { kind: "reading", key, file, progress: null };
        return index === 0 ? [next, cur[1]] : [cur[0], next];
      });
      const back = (e: UiError) => settle(key, { kind: "empty", error: e });
      const progress = (done: number, total: number) =>
        setSlots((cur) => cur.map((s) => (s.kind === "reading" && s.key === key ? { ...s, progress: { done, total } } : s)) as [Slot, Slot]);
      try {
        const bytes = await readFileAsUint8Array(file);
        const sizes = await pageSizes(bytes);
        if (sizes.length > MAX_PAGES) return back(t("tooManyPages", { name: file.name, count: sizes.length, max: MAX_PAGES }));
        if (ctrl.signal.aborted) return;
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        try {
          const words = await extractWords(doc as unknown as PdfLike, progress, ctrl.signal);
          settle(key, { kind: "ready", key, file, sizes, words });
        } finally {
          void doc.destroy();
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        back(e instanceof UserError ? e.message : describe(e));
      } finally {
        reads.current.delete(key);
      }
    },
    [worker.initError, worker.ready, pageSizes, settle, t, tc, describe],
  );

  const remove = (index: 0 | 1) =>
    setSlots((cur) => {
      const old = cur[index];
      if (old.kind === "reading") reads.current.get(old.key)?.abort();
      return index === 0 ? [EMPTY, cur[1]] : [cur[0], EMPTY];
    });
  const swap = () => setSlots(([x, y]) => [y, x]);

  const [sa, sb] = slots;
  const aKey = sa.kind === "ready" ? sa.key : 0;
  const bKey = sb.kind === "ready" ? sb.key : 0;

  // Compare whenever both documents are read; a newer pair (swap, replace, remove) supersedes the run.
  useEffect(() => {
    const current = latest.begin();
    setError(null);
    if (sa.kind !== "ready" || sb.kind !== "ready") {
      compareRef.current?.client.cancel();
      setDiff({ status: "idle" });
      return;
    }
    const client = compareRef.current?.client;
    if (!client) {
      setDiff({ status: "idle" });
      setError(tc("errorCompareFailed"));
      return;
    }
    setDiff({ status: "running", aKey: sa.key, bKey: sb.key });
    client.compare(sa.words, sb.words).then(
      (result) => {
        if (current()) setDiff({ status: "done", aKey: sa.key, bKey: sb.key, result });
      },
      (e: unknown) => {
        if (!current() || (e instanceof Error && e.name === "AbortError")) return;
        setDiff({ status: "idle" });
        setError(describe(e));
      },
    );
    // Keys identify the documents: words and sizes never change for a key.
  }, [aKey, bKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = sa.kind === "ready" ? sa : null;
  const b = sb.kind === "ready" ? sb : null;
  const result = diff.status === "done" && a && b && diff.aKey === a.key && diff.bKey === b.key ? diff.result : null;
  const reading = sa.kind === "reading" || sb.kind === "reading";
  const running = !!a && !!b && !result && !error;
  const noTextA = a !== null && countWords(a.words) === 0;
  const noTextB = b !== null && countWords(b.words) === 0;

  const status = reading
    ? t("reading")
    : running
      ? t("comparing")
      : result
        ? result.changes.length === 0
          ? t("noDifferences")
          : t("summaryLine", {
              changes: t("summary", { count: result.changes.length }),
              added: t("addedCount", { count: result.stats.added }),
              removed: t("removedCount", { count: result.stats.removed }),
              changed: t("changedCount", { count: result.stats.changed }),
            })
        : "";

  const anyFile = sa.kind !== "empty" || sb.kind !== "empty";

  return (
    <ToolShell tool="compare" title={t("seoTitle")} description={t("seoDescription")} path="/compare" heading={t("heading")} intro={t("intro")} wide>
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      <div className="mt-8 grid items-stretch gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-6">
        <FileSlot
          maxMb={MAX_MB}
          marker="A"
          label={t("original")}
          removeLabel={t("removeOriginal")}
          slot={slotView(sa)}
          engineReady={worker.ready}
          onFile={(f) => void pick(0, f)}
          onRemove={() => remove(0)}
          testId="compare-slot-a"
        />
        <div className="flex items-center justify-center sm:pt-6">
          <button type="button" onClick={swap} disabled={!anyFile} aria-label={t("swapLabel")} title={t("swapLabel")} className={`${secondaryButton} gap-2 !px-4`}>
            <ArrowLeftRight aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 rotate-90 sm:rotate-0" />
            <span>{t("swap")}</span>
          </button>
        </div>
        <FileSlot
          maxMb={MAX_MB}
          marker="B"
          label={t("modified")}
          removeLabel={t("removeModified")}
          slot={slotView(sb)}
          engineReady={worker.ready}
          onFile={(f) => void pick(1, f)}
          onRemove={() => remove(1)}
          testId="compare-slot-b"
        />
      </div>

      <p className="sr-only" role="status" aria-live="polite" data-testid="compare-status">
        {status}
      </p>

      {(a && !b && sb.kind === "empty") || (b && !a && sa.kind === "empty") ? (
        <p className={`${monoLabel} mt-6`}>{a ? t("waiting") : t("waitingOriginal")}</p>
      ) : null}

      <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-6" />

      {(noTextA || noTextB) && (
        <p className={`mt-6 flex gap-2 ${noticeClass}`} data-testid="compare-no-text">
          {warnIcon}
          <span>
            <Trans ns="compare" k={noTextA && noTextB ? "noTextBoth" : noTextA ? "noTextOriginal" : "noTextModified"} components={{ link: ocrLink }} />
          </span>
        </p>
      )}

      {a && b && (
        <div className="mt-8 flex items-center gap-3" role="group" aria-labelledby="compare-view-label">
          <span id="compare-view-label" className={monoLabel}>
            {t("viewLabel")}
          </span>
          <ToggleChip on={view === "text"} onClick={() => setView("text")} className="!h-8 !px-3">
            {t("viewText")}
          </ToggleChip>
          <ToggleChip
            on={view === "overlay"}
            onClick={() => {
              setView("overlay");
              setOverlayUsed(true);
            }}
            className="!h-8 !px-3"
          >
            {t("viewOverlay")}
          </ToggleChip>
        </div>
      )}

      {(reading || (running && view === "text")) && (
        <div className="mt-10 flex items-center gap-3" aria-hidden="true">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent motion-reduce:animate-none" />
          <span className={monoLabel}>{reading ? t("reading") : t("comparing")}</span>
        </div>
      )}

      {/* Both views stay mounted once used (the hidden one keeps its scroll, picked change and overlay cache). */}
      {a && b && result && !(noTextA && noTextB) && (
        <div hidden={view !== "text"}>
          <TextView a={a} b={b} result={result} />
        </div>
      )}
      {/* Keyed by both documents: a new file or a swap remounts it, which cancels everything in flight. */}
      {overlayUsed && a && b && (
        <div hidden={view !== "overlay"}>
          <OverlayView key={`${a.key}-${b.key}`} fileA={a.file} fileB={b.file} sizesA={a.sizes} sizesB={b.sizes} />
        </div>
      )}
    </ToolShell>
  );
}
