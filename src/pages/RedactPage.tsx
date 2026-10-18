import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import { pdfjs } from "../lib/pdf";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageStrip from "../components/editor/PageStrip";
import MarksPanel from "../components/redact/MarksPanel";
import RedactCanvas from "../components/redact/RedactCanvas";
import SearchBar, { type SearchResult } from "../components/redact/SearchBar";
import {
  addMarks,
  canRedo,
  canUndo,
  clearMarks,
  initialMarks,
  redo,
  removeMark,
  togglePage,
  undo,
  updateMark,
  type MarkInput,
  type MarksState,
  type Rect,
} from "../lib/redact/model";
import { formatPageRanges, parsePageRanges } from "../lib/pagePlan";
import { numberEntries, repeatTargets } from "../lib/redact/marking";
import { chooseDpi, renderRaster } from "../lib/redact/raster";
import { REPORT_TITLE, TOO_LARGE_REASON, neededRasters, plainReason, reportLines, uncoveredNote } from "../lib/redact/report";
import { findMatches, type TextRun } from "../lib/redact/search";
import {
  marksToRects,
  sameRun,
  takeRun,
  toJob,
  type Fill,
  type PageStatusWire,
  type RasterWire,
  type RedactResultWire,
  type RedactRun,
} from "../lib/redact/toJob";
import ToolShell, { primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";

const KEEP_ORIGINAL = "Redaction permanently removes the marked content. Keep your original file.";
const ALSO_REMOVED = "Comments are removed from the whole document, and form fields are flattened.";

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

interface WorkspaceProps {
  input: PdfInput<[number, number][]>;
  busy: boolean;
  run: <R>(work: () => Promise<R>, done: (result: R) => void) => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
  worker: ReturnType<typeof usePdfWorker>;
  onStartOver: () => void;
}

function Workspace({ input, busy, run, error, setError, worker, onStartOver }: WorkspaceProps) {
  const sizes = input.data;
  const [state, setState] = useState<MarksState>(initialMarks);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fill, setFill] = useState<Fill>("black");
  const [removeMetadata, setRemoveMetadata] = useState(true);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<(SearchResult & { truncated: boolean }) | null>(null);
  // Pages the engine cannot redact in place, waiting for the user's go-ahead, for that run.
  const [confirm, setConfirm] = useState<{ run: RedactRun; pages: PageStatusWire[] } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<RedactResultWire | null>(null);
  // Pages the last search could not fully cover: kept (next to the marks and in the report)
  // after "Mark all", until the next search or Start over.
  const [coverage, setCoverage] = useState<{ undecodable: number[]; unsearched: number[] } | null>(null);
  const uncovered = coverage ? [...new Set([...coverage.undecodable, ...coverage.unsearched])].sort((a, b) => a - b) : [];
  const continueRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const docRef = useRef<Promise<PdfDocument> | null>(null);

  const { marks } = state;
  const pageSize = sizes[page - 1] ?? null;
  const pageMarks = useMemo(() => marks.filter((m) => m.page === page), [marks, page]);
  const marked = useMemo(() => new Set(marks.map((m) => m.page)), [marks]);
  const wholePage = pageMarks.some((m) => m.kind === "page");
  // The selected area or search match, which "Repeat on pages" copies.
  const selectedMark = pageMarks.find((m) => m.id === selectedId && m.kind !== "page") ?? null;
  const [repeatText, setRepeatText] = useState("");
  const [repeatNote, setRepeatNote] = useState<string | null>(null);
  useEffect(() => setRepeatNote(null), [selectedId]);

  // One pdf.js document for search and rasters, opened when first needed, closed with the page.
  const openDoc = useCallback((): Promise<PdfDocument> => {
    docRef.current ??= pdfjs.getDocument({ data: input.bytes.slice() }).promise;
    return docRef.current;
  }, [input.bytes]);
  useEffect(
    () => () => {
      void docRef.current?.then((d) => d.destroy(), () => undefined);
      docRef.current = null;
    },
    [],
  );

  // Marks live only in memory: warn before the tab is closed or reloaded.
  const hasMarks = marks.length > 0;
  useEffect(() => {
    if (!hasMarks) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasMarks]);

  // Marks are locked while a redaction runs or waits for its go-ahead: the run uses a snapshot.
  const locked = busy || confirm !== null;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // The marks and options as they are now, for the defensive check before a run goes on.
  const currentRun = useRef<RedactRun>(takeRun(marks, fill, removeMetadata));
  currentRun.current = takeRun(marks, fill, removeMetadata);

  // Undo / redo from the keyboard, except while typing in a field or while locked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lockedRef.current || isTyping(e.target) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) setState(undo);
      else if ((key === "z" && e.shiftKey) || key === "y") setState(redo);
      else return;
      // Like the buttons: the report was for the marks as they were.
      setReport(null);
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const change = (next: (s: MarksState) => MarksState) => {
    if (lockedRef.current) return;
    setReport(null);
    setState(next);
  };

  // The confirmation takes focus when it opens.
  useEffect(() => {
    if (confirm) continueRef.current?.focus();
  }, [confirm]);

  const find = async (query: string, wholeWord: boolean) => {
    // A search never clears a redaction's error; it only adds its own on failure.
    if (lockedRef.current) return;
    setSearching(true);
    try {
      // The engine finds the exact glyph boxes, one rect per line of each match.
      const result = await worker.redactSearch(input.bytes, query, { wholeWord, caseSensitive: false });
      const found: MarkInput[] = [];
      const pages = new Set<number>();
      for (const { page: n, quads } of result.pages) {
        if (quads.length > 0) pages.add(n);
        for (const rect of quads) found.push({ kind: "search", page: n, rect, query });
      }
      // Pages whose text the engine cannot decode: pdf.js may still read it. Whole items, since
      // its per-character split is approximate (a whole item never misses a glyph).
      if (result.undecodablePages.length > 0) {
        const doc = await openDoc();
        for (const n of result.undecodablePages) {
          const p = await doc.getPage(n);
          const content = await p.getTextContent();
          const runs: TextRun[] = [];
          for (const item of content.items) {
            if ("str" in item) runs.push({ str: item.str, transform: item.transform, width: item.width, hasEOL: item.hasEOL });
          }
          const view = p.view as [number, number, number, number];
          for (const m of findMatches(runs, { view, rotate: p.rotate }, query, { wholeWord })) {
            // One mark per line of a match, never their union (which would cover the lines between).
            for (const rect of m.rects) found.push({ kind: "search", page: n, rect, query });
            pages.add(n);
          }
        }
      }
      setCoverage({ undecodable: result.undecodablePages, unsearched: result.unsearchedPages });
      setSearch({
        query,
        count: found.length,
        pages: [...pages].sort((a, b) => a - b),
        entries: numberEntries(found),
        truncated: result.truncated,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  /** Copy `rect` from this page to the pages of `text` ("all", or ranges like "2-5, 8"). */
  const repeat = (rect: Rect, text: string) => {
    if (lockedRef.current) return;
    const parsed = text === "all" ? { ok: true as const, pages: sizes.map((_, i) => i + 1) } : parsePageRanges(text, sizes.length);
    if (!parsed.ok) {
      setRepeatNote(parsed.error);
      return;
    }
    const { marks: copies, skipped } = repeatTargets(rect, page, parsed.pages, sizes);
    change((s) => addMarks(s, copies));
    const added = `Added to ${copies.length} ${copies.length === 1 ? "page" : "pages"}.`;
    setRepeatNote(skipped.length > 0 ? `${added} Skipped (too small): ${formatPageRanges(skipped)}.` : added);
  };

  /** Mark the reviewed search areas (the checked ones, or all). */
  const markFound = (found: MarkInput[]) => {
    if (!search || lockedRef.current || found.length === 0) return;
    change((s) => addMarks(s, found));
    const pages = [...new Set(found.map((m) => m.page))].sort((a, b) => a - b);
    if (!pages.includes(page)) setPage(pages[0]);
    setSearch(null);
  };

  /**
   * For `snap`: rasters of `pages` (rendered again on every attempt: they are handed over to the
   * worker), then the redaction, then the download.
   */
  const redactWith = (snap: RedactRun, planned: PageStatusWire[]) => {
    setConfirm(null);
    const pages = planned.map((p) => p.page);
    const dpi = chooseDpi(pages.map((p) => sizes[p - 1] ?? [0, 0]));
    if (dpi === null) {
      setError("Too many pages need to be converted to images at once. Split the PDF first.");
      return;
    }
    const rects = marksToRects(snap.marks, sizes);
    const name = `${baseName(input.file)}_redacted.pdf`;
    void run(
      async () => {
        try {
          const rasters: RasterWire[] = [];
          for (const [i, p] of pages.entries()) {
            setProgress(`Converting page ${p} to an image (${i + 1} of ${pages.length})…`);
            const doc = await openDoc();
            const pageRects: Rect[] = rects.filter((r) => r.page === p).map((r) => r.rect);
            rasters.push(await renderRaster(doc, p, pageRects, snap.fill, dpi));
          }
          setProgress("Removing the marked content…");
          const job = toJob(snap.marks, sizes, { fill: snap.fill, removeMetadata: snap.removeMetadata }, rasters);
          try {
            return { kind: "done", result: await worker.redactPdf(input.bytes, job) } as const;
          } catch (err) {
            // The engine found, while redacting, pages it can only handle as images (very large
            // images): ask again, never show its raw message.
            const late = neededRasters(err instanceof Error ? err.message : String(err));
            if (late) return { kind: "late", pages: late } as const;
            throw err;
          }
        } finally {
          setProgress(null);
        }
      },
      (outcome) => {
        if (outcome.kind === "late") {
          const known = new Set(pages);
          const more = outcome.pages.filter((p) => !known.has(p)).map((page) => ({ page, reason: TOO_LARGE_REASON }));
          setConfirm({ run: snap, pages: [...planned, ...more].sort((a, b) => a.page - b.page) });
          return;
        }
        downloadBlob(outcome.result.bytes, name);
        setReport(outcome.result);
      },
    );
  };

  /** Plan `snap`; a run whose marks changed meanwhile is dropped and planned again. */
  const plan = (snap: RedactRun) => {
    const rects = marksToRects(snap.marks, sizes);
    void run(
      () => worker.redactPlan(input.bytes, rects),
      (result) => {
        if (!sameRun(snap, currentRun.current)) return plan(currentRun.current);
        const fallback = result.filter((p) => p.reason !== null);
        if (fallback.length > 0) setConfirm({ run: snap, pages: fallback });
        else redactWith(snap, []);
      },
    );
  };

  const start = () => {
    if (busy || confirm !== null || marks.length === 0) return;
    setReport(null);
    plan(takeRun(marks, fill, removeMetadata));
  };

  const goAhead = () => {
    if (!confirm) return;
    // Defensive: editing is locked meanwhile, but never redact with rasters of other marks.
    if (!sameRun(confirm.run, currentRun.current)) {
      setConfirm(null);
      plan(currentRun.current);
      return;
    }
    redactWith(confirm.run, confirm.pages);
  };

  const startOver = () => {
    if (hasMarks && !window.confirm("Discard all your marks and start over?")) return;
    onStartOver();
  };

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
          {input.file.name} ({sizes.length} {sizes.length === 1 ? "page" : "pages"})
        </p>
        <div className="flex gap-3">
          <button type="button" onClick={start} disabled={busy || marks.length === 0 || confirm !== null} className={primaryButton}>
            {busy ? (progress ?? "Checking pages…") : "Redact and download"}
          </button>
          <button type="button" onClick={startOver} className={secondaryButton}>
            Start over
          </button>
        </div>
      </div>

      <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-[#1f1a0a] dark:text-amber-200">
        {KEEP_ORIGINAL} {ALSO_REMOVED}
      </p>

      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      {progress && (
        <p role="status" className="text-sm text-gray-700 dark:text-[#aaa]">
          {progress}
        </p>
      )}

      {confirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="redact-raster-title"
          onKeyDown={(e) => {
            // Escape is Cancel; Tab stays between the two buttons.
            if (e.key === "Escape") {
              e.preventDefault();
              setConfirm(null);
            } else if (e.key === "Tab") {
              e.preventDefault();
              (document.activeElement === continueRef.current ? cancelRef.current : continueRef.current)?.focus();
            }
          }}
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-[#1f1a0a]"
        >
          <p id="redact-raster-title" className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Some pages cannot be redacted in place:
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
            {confirm.pages.map((p) => (
              <li key={p.page}>
                Page {p.page} will be converted to an image: it {plainReason(p.reason ?? "")}.{" "}
                <details className="inline">
                  <summary className="inline cursor-pointer text-xs underline">Details</summary>
                  <span className="ml-1 text-xs">{p.reason}</span>
                </details>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Its text will no longer be selectable or searchable.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button ref={continueRef} type="button" onClick={goAhead} className={primaryButton}>
              Continue
            </button>
            <button ref={cancelRef} type="button" onClick={() => setConfirm(null)} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {report && (
        <div role="status" className="rounded-lg border border-mantis-300 bg-mantis-50 p-3 text-sm text-mantis-900 dark:border-mantis-800 dark:bg-[#0f1a0f] dark:text-mantis-200">
          <p className="font-medium">Redacted and downloaded. {REPORT_TITLE}</p>
          <ul className="mt-1 list-disc pl-5">
            {reportLines(report, uncovered).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {sizes.length > 1 && (
        <PageStrip source={input.file} pageCount={sizes.length} page={page} edited={marked} onPage={setPage} markLabel="has marks" />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {pageSize && (
            <RedactCanvas
              source={input.file}
              page={page}
              pageSize={pageSize}
              marks={pageMarks}
              fill={fill}
              locked={locked}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={(rect) => change((s) => addMarks(s, [{ kind: "area", page, rect }]))}
              onUpdate={(id, rect) => change((s) => updateMark(s, id, rect))}
              onDelete={(id) => {
                setSelectedId(null);
                change((s) => removeMark(s, id));
              }}
            />
          )}
          {selectedMark && selectedMark.kind !== "page" && sizes.length > 1 && (
            <form
              aria-label="Repeat on pages"
              className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 text-sm dark:border-[#333] dark:bg-[#111]"
              onSubmit={(e) => {
                e.preventDefault();
                repeat(selectedMark.rect, repeatText);
              }}
            >
              <span className="font-medium text-gray-800 dark:text-[#ccc]">Repeat this area on</span>
              <button type="button" disabled={locked} onClick={() => repeat(selectedMark.rect, "all")} className={secondaryButton}>
                All pages
              </button>
              <span className="text-gray-500 dark:text-[#888]">or pages</span>
              <input
                aria-label="Pages to repeat the area on"
                value={repeatText}
                onChange={(e) => setRepeatText(e.target.value)}
                placeholder="2-5, 8"
                className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-[#333] dark:bg-[#111] dark:text-[#ddd]"
              />
              <button type="submit" disabled={locked || repeatText.trim() === ""} className={secondaryButton}>
                Repeat
              </button>
              {repeatNote && (
                <p role="status" className="basis-full text-xs text-gray-600 dark:text-[#999]">
                  {repeatNote}
                </p>
              )}
            </form>
          )}
        </div>
        <aside className="space-y-4">
          <SearchBar
            searching={searching}
            result={search}
            onFind={(q, w) => void find(q, w)}
            onMark={markFound}
            onShowPage={setPage}
            locked={locked}
          />
          {search && search.truncated && (
            <p role="note" className="text-xs text-amber-800 dark:text-amber-300">
              Too many matches; showing the first {search.count}. Refine the search.
            </p>
          )}
          {coverage && coverage.undecodable.length > 0 && (
            <p role="note" className="text-xs text-amber-800 dark:text-amber-300">
              Search may miss text on {coverage.undecodable.length === 1 ? "page" : "pages"} {coverage.undecodable.join(", ")}. Mark those areas by hand.
            </p>
          )}
          {coverage && coverage.unsearched.length > 0 && (
            <p role="note" className="text-xs text-amber-800 dark:text-amber-300">
              Not searched: {coverage.unsearched.length === 1 ? "page" : "pages"} {coverage.unsearched.join(", ")}. {uncoveredNote([], coverage.unsearched)}
            </p>
          )}
          <MarksPanel
            marks={marks}
            page={page}
            onPage={setPage}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={(id) => {
              if (id === selectedId) setSelectedId(null);
              change((s) => removeMark(s, id));
            }}
            onClear={() => {
              setSelectedId(null);
              change(clearMarks);
            }}
            canUndo={canUndo(state)}
            canRedo={canRedo(state)}
            onUndo={() => change(undo)}
            onRedo={() => change(redo)}
            wholePage={wholePage}
            onToggleWholePage={() => change((s) => togglePage(s, page))}
            fill={fill}
            onFill={setFill}
            removeMetadata={removeMetadata}
            onRemoveMetadata={setRemoveMetadata}
            locked={locked}
          />
        </aside>
      </div>
    </div>
  );
}

export default function RedactPage() {
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  return (
    <ToolShell
      wide={input !== null}
      title="Redact PDF: Permanently Remove Text and Images | MantisPDF"
      description="Redact a PDF in your browser: mark areas or find text, and the content under the marks is removed from the file, not just covered. Free, private, nothing is uploaded."
      path="/redact"
      heading="Redact PDF"
      intro="Mark areas or find text to remove. The content under the marks is deleted from the file, not just hidden. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mx-auto mt-8 max-w-2xl">
          <DropZone onFile={(f) => void pick(f)} error={error} engineReady={worker.ready} />
          <p className="mt-4 text-sm text-gray-600 dark:text-[#888]">
            {KEEP_ORIGINAL} {ALSO_REMOVED}
          </p>
        </div>
      )}

      {input && <Workspace input={input} busy={busy} run={run} error={error} setError={setError} worker={worker} onStartOver={reset} />}
    </ToolShell>
  );
}
