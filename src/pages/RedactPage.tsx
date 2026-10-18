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
import { chooseDpi, renderRaster } from "../lib/redact/raster";
import { findMatches, type TextRun } from "../lib/redact/search";
import { marksToRects, toJob, type Fill, type PageStatusWire, type RasterWire, type RedactResultWire } from "../lib/redact/toJob";
import ToolShell, { primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";

const KEEP_ORIGINAL = "Redaction permanently removes the marked content. Keep your original file.";

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** One line of the success report, or null when there is nothing to say. */
function reportLines(r: RedactResultWire): string[] {
  const lines: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  lines.push(`${count(r.pagesRedacted.length, "page", "pages")} redacted.`);
  if (r.glyphsRemoved > 0) lines.push(`${count(r.glyphsRemoved, "character", "characters")} of text removed.`);
  if (r.imagesRedacted > 0) lines.push(`${count(r.imagesRedacted, "image", "images")} blacked out where marked.`);
  if (r.imagesRemoved > 0) lines.push(`${count(r.imagesRemoved, "image", "images")} removed entirely (could not be edited safely).`);
  if (r.pathsRemoved > 0) lines.push(`${count(r.pathsRemoved, "drawing", "drawings")} removed.`);
  if (r.annotationsRemoved > 0) lines.push(`${count(r.annotationsRemoved, "annotation or link", "annotations or links")} removed.`);
  if (r.pagesRasterized.length > 0) {
    lines.push(`Converted to images: ${r.pagesRasterized.length === 1 ? "page" : "pages"} ${r.pagesRasterized.join(", ")}.`);
  }
  return lines;
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
  const [search, setSearch] = useState<(SearchResult & { marks: MarkInput[]; undecodablePages: number[] }) | null>(null);
  // Pages the engine cannot redact in place, waiting for the user's go-ahead.
  const [confirm, setConfirm] = useState<PageStatusWire[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<RedactResultWire | null>(null);
  const docRef = useRef<Promise<PdfDocument> | null>(null);

  const { marks } = state;
  const pageSize = sizes[page - 1] ?? null;
  const pageMarks = useMemo(() => marks.filter((m) => m.page === page), [marks, page]);
  const marked = useMemo(() => new Set(marks.map((m) => m.page)), [marks]);
  const wholePage = pageMarks.some((m) => m.kind === "page");

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

  // A pending go-ahead was for the marks as they were: any change asks again.
  useEffect(() => setConfirm(null), [marks, fill]);

  // Undo / redo from the keyboard, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) setState(undo);
      else if ((key === "z" && e.shiftKey) || key === "y") setState(redo);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const change = (next: (s: MarksState) => MarksState) => {
    setReport(null);
    setState(next);
  };

  const find = async (query: string, wholeWord: boolean) => {
    setSearching(true);
    setError(null);
    try {
      const doc = await openDoc();
      const found: MarkInput[] = [];
      const pages: number[] = [];
      let count = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n);
        const content = await p.getTextContent();
        const runs: TextRun[] = [];
        for (const item of content.items) {
          if ("str" in item) runs.push({ str: item.str, transform: item.transform, width: item.width, hasEOL: item.hasEOL });
        }
        const view = p.view as [number, number, number, number];
        // Whole items: the per-character split is approximate, a whole item never misses a glyph.
        const matches = findMatches(runs, { view, rotate: p.rotate }, query, { wholeWord, wholeItem: true });
        if (matches.length > 0) pages.push(n);
        count += matches.length;
        // One mark per line of a match, never their union (which would cover the lines between).
        for (const m of matches) for (const rect of m.rects) found.push({ kind: "search", page: n, rect, query });
      }
      setSearch({ query, count, pages, marks: found, undecodablePages: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const markAll = () => {
    if (!search) return;
    change((s) => addMarks(s, search.marks));
    if (search.pages.length > 0 && !search.pages.includes(page)) setPage(search.pages[0]);
    setSearch(null);
  };

  /**
   * Rasters for `pages` (rendered again on every attempt: they are handed over to the worker),
   * then the redaction, then the download.
   */
  const redactWith = (pages: number[]) => {
    setConfirm(null);
    const dpi = chooseDpi(pages.map((p) => sizes[p - 1] ?? [0, 0]));
    if (dpi === null) {
      setError("Too many pages need to be converted to images at once. Split the PDF first.");
      return;
    }
    const rects = marksToRects(marks, sizes);
    const name = `${baseName(input.file)}_redacted.pdf`;
    void run(
      async () => {
        try {
          const rasters: RasterWire[] = [];
          for (const [i, p] of pages.entries()) {
            setProgress(`Converting page ${p} to an image (${i + 1} of ${pages.length})…`);
            const doc = await openDoc();
            const pageRects: Rect[] = rects.filter((r) => r.page === p).map((r) => r.rect);
            rasters.push(await renderRaster(doc, p, pageRects, fill, dpi));
          }
          setProgress("Removing the marked content…");
          return await worker.redactPdf(input.bytes, toJob(marks, sizes, { fill, removeMetadata }, rasters));
        } finally {
          setProgress(null);
        }
      },
      (result) => {
        downloadBlob(result.bytes, name);
        setReport(result);
      },
    );
  };

  const start = () => {
    if (busy || marks.length === 0) return;
    setReport(null);
    const rects = marksToRects(marks, sizes);
    void run(
      () => worker.redactPlan(input.bytes, rects),
      (plan) => {
        const fallback = plan.filter((p) => p.reason !== null);
        if (fallback.length > 0) setConfirm(fallback);
        else redactWith([]);
      },
    );
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
        {KEEP_ORIGINAL}
      </p>

      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      {progress && (
        <p role="status" className="text-sm text-gray-700 dark:text-[#aaa]">
          {progress}
        </p>
      )}

      {confirm && (
        <div role="alertdialog" aria-labelledby="redact-raster-title" className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-[#1f1a0a]">
          <p id="redact-raster-title" className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Some pages cannot be redacted in place:
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
            {confirm.map((p) => (
              <li key={p.page}>
                Page {p.page} will be converted to an image ({p.reason}).
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Its text will no longer be selectable or searchable.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => redactWith(confirm.map((p) => p.page))} className={primaryButton}>
              Continue
            </button>
            <button type="button" onClick={() => setConfirm(null)} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {report && (
        <div role="status" className="rounded-lg border border-mantis-300 bg-mantis-50 p-3 text-sm text-mantis-900 dark:border-mantis-800 dark:bg-[#0f1a0f] dark:text-mantis-200">
          <p className="font-medium">Redacted and downloaded. The content under the marks has been checked and is gone.</p>
          <ul className="mt-1 list-disc pl-5">
            {reportLines(report).map((line) => (
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
        </div>
        <aside className="space-y-4">
          <SearchBar searching={searching} result={search} onFind={(q, w) => void find(q, w)} onMarkAll={markAll} />
          {search && search.undecodablePages.length > 0 && (
            <p role="note" className="text-xs text-amber-800 dark:text-amber-300">
              Search may miss text on {search.undecodablePages.length === 1 ? "page" : "pages"} {search.undecodablePages.join(", ")}. Mark those areas by hand.
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
          <p className="mt-4 text-sm text-gray-600 dark:text-[#888]">{KEEP_ORIGINAL}</p>
        </div>
      )}

      {input && <Workspace input={input} busy={busy} run={run} error={error} setError={setError} worker={worker} onStartOver={reset} />}
    </ToolShell>
  );
}
