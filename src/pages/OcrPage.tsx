import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../i18n";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import { pdfjs } from "../lib/pdf";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageStrip from "../components/editor/PageStrip";
import { OCR_CANCELLED, OCR_NOT_STARTED, OcrEngine, isOcrCancelled, ocrWorkerCount } from "../lib/ocr/engine";
import { OCR_LANGUAGES, defaultLanguages, type OcrLanguage } from "../lib/ocr/languages";
import { runPipeline } from "../lib/ocr/pipeline";
import { renderPageImage } from "../lib/ocr/render";
import {
  alreadyOcrLine,
  estimateRemainingMs,
  failedLine,
  formatEta,
  fromPipeline,
  loadingLabel,
  skippedLine,
  summarize,
  summaryHeadline,
  toggleLanguage,
  wholeDocumentText,
  wordLimitProblem,
  type OcrRunResult,
} from "../lib/ocr/run";
import { exportText } from "../lib/ocr/text";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";
import type { UiError } from "../i18n";

/** The engine's page limit (`add_text_layer`). */
const MAX_PAGES = 2000;
const linkClass = "font-medium text-mantis-700 underline dark:text-mantis-400";

interface Progress {
  done: number;
  /** Pages recognised so far (skipped pages do not set the pace). */
  recognised: number;
  /** Progress (0..1) of the pages being recognised right now, summed: a smoother bar. */
  partial: number;
  total: number;
  startedAt: number;
  /** What happens now (loading models, a page number). */
  status: string;
}

/** What one run produced. */
type OcrResult = OcrRunResult;

interface WorkspaceProps {
  input: PdfInput<[number, number][]>;
  busy: boolean;
  run: <R>(work: () => Promise<R>, done: (result: R) => void) => Promise<void>;
  error: UiError | null;
  setError: (error: UiError | null) => void;
  addTextLayer: ReturnType<typeof usePdfWorker>["addTextLayer"];
  onStartOver: () => void;
}

function Workspace({ input, busy, run, error, setError, addTextLayer, onStartOver }: WorkspaceProps) {
  const sizes = input.data;
  const [languages, setLanguages] = useState<OcrLanguage[]>(() =>
    defaultLanguages(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]),
  );
  const [skipText, setSkipText] = useState(true);
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  // After the searchable PDF is downloaded, leaving or starting over loses nothing (as in Compress, Merge, Split).
  const [downloaded, setDownloaded] = useState(false);
  // Pages the text layer left alone because they already had one (a second pass).
  const [alreadyOcr, setAlreadyOcr] = useState<number[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const engineRef = useRef<OcrEngine | null>(null);
  // Aborts the engine start too (core and model downloads).
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const running = progress !== null;

  const summary = useMemo(() => (result ? summarize(result.outcomes) : null), [result]);
  const recognised = useMemo(() => new Set(result?.layer.map((p) => p.page) ?? []), [result]);

  // The ETA ticks while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Leaving mid-run or with results not yet downloaded loses the work: warn first.
  useEffect(() => {
    if (!running && (!result || downloaded)) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running, result, downloaded]);

  // Stop the workers if the page goes away mid-run.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
      void engineRef.current?.terminate();
    },
    [],
  );

  const runOcr = async () => {
    if (running || busy) return;
    if (sizes.length > MAX_PAGES) {
      setError(`OCR handles at most ${MAX_PAGES} pages at once. Split the PDF first.`);
      return;
    }
    setError(null);
    setResult(null);
    cancelledRef.current = false;
    const abort = new AbortController();
    abortRef.current = abort;
    const total = sizes.length;
    setDownloaded(false);
    setAlreadyOcr([]);
    setProgress({ done: 0, recognised: 0, partial: 0, total, startedAt: Date.now(), status: loadingLabel(null) });
    const workers = ocrWorkerCount(typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency);
    let engine: OcrEngine | null = null;
    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | null = null;
    try {
      engine = await OcrEngine.create(languages, {
        workers,
        origin: window.location.origin,
        signal: abort.signal,
        onProgress: (p) => setProgress((pr) => (pr && pr.done === 0 && pr.recognised === 0 ? { ...pr, status: loadingLabel(p) } : pr)),
      });
      engineRef.current = engine;
      if (cancelledRef.current) throw new Error(OCR_CANCELLED);
      doc = await pdfjs.getDocument({ data: input.bytes.slice() }).promise;
      const pdf = doc;
      const startedAt = Date.now();
      let done = 0;
      let recognisedPages = 0;
      setProgress({ done: 0, recognised: 0, partial: 0, total, startedAt, status: "Reading page 1" });
      // Progress of the pages in flight, by page number.
      const inFlight = new Map<number, number>();
      const showPartial = () => {
        let sum = 0;
        for (const v of inFlight.values()) sum += v;
        setProgress((pr) => (pr ? { ...pr, partial: sum } : pr));
      };
      const pages = await runPipeline(
        {
          pageCount: total,
          pageSize: (n) => sizes[n - 1],
          textItems: async (n) => {
            const p = await pdf.getPage(n);
            const content = await p.getTextContent();
            p.cleanup();
            return content.items;
          },
          render: (n) => renderPageImage(pdf, n),
        },
        engine,
        {
          lanes: workers,
          skipText,
          isCancelled: () => cancelledRef.current,
          onPageStart: (n) => {
            inFlight.set(n, 0);
            setProgress((pr) => (pr ? { ...pr, status: `Reading page ${n}` } : pr));
          },
          onPageProgress: (n, fraction) => {
            inFlight.set(n, fraction);
            showPartial();
          },
          onPageDone: (page) => {
            inFlight.delete(page.page);
            done++;
            if (!page.skipped) recognisedPages++;
            setProgress((pr) => (pr ? { ...pr, done, recognised: recognisedPages } : pr));
            showPartial();
          },
        },
      );
      setResult(fromPipeline(pages));
    } catch (e) {
      if (cancelledRef.current || isOcrCancelled(e)) return;
      const message = e instanceof Error ? e.message : String(e);
      setError(
        message === OCR_NOT_STARTED ? "The OCR engine could not start. Check your connection to this site and try again." : message,
      );
    } finally {
      engineRef.current = null;
      abortRef.current = null;
      setProgress(null);
      void engine?.terminate();
      void doc?.destroy();
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    void engineRef.current?.terminate();
  };

  const downloadPdf = () => {
    if (!result) return;
    setAlreadyOcr([]);
    const tooMany = wordLimitProblem(result.layer);
    if (tooMany) {
      setError(tooMany);
      return;
    }
    void run(
      () => addTextLayer(input.bytes, result.layer),
      (out) => {
        downloadBlob(out.bytes, `${baseName(input.file)}_ocr.pdf`);
        setAlreadyOcr(out.alreadyOcrPages);
        setDownloaded(true);
      },
    );
  };

  const downloadText = () => {
    if (!result) return;
    // The text alone is not the searchable PDF: leaving still warns until the PDF is downloaded.
    downloadBlob(new TextEncoder().encode(exportText(wholeDocumentText(result.texts, result.skippedTexts))), `${baseName(input.file)}_ocr.txt`);
  };

  const startOver = () => {
    if ((running || (result && !downloaded)) && !window.confirm("Discard the recognised text and start over?")) return;
    cancel();
    onStartOver();
  };

  // The pace comes from recognised pages only (skipped ones are quick); every page left may need OCR.
  const eta = progress
    ? formatEta(
        estimateRemainingMs({
          done: progress.recognised,
          total: progress.recognised + (progress.total - progress.done),
          elapsedMs: now - progress.startedAt,
        }),
      )
    : "";
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round(((progress.done + progress.partial) / progress.total) * 100)) : 0;

  return (
    <div className={panelClass}>
      <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
        {input.file.name} ({sizes.length} {sizes.length === 1 ? "page" : "pages"})
      </p>

      {sizes.length > 0 && (
        <div className="mt-4">
          <PageStrip
            source={input.file}
            pageCount={sizes.length}
            page={page}
            edited={recognised}
            onPage={setPage}
            markLabel="text recognised"
          />
        </div>
      )}

      <fieldset className="mt-6" disabled={running}>
        <legend className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">Languages in the document</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {OCR_LANGUAGES.map((l) => {
            const on = languages.includes(l.code);
            return (
              <button
                key={l.code}
                type="button"
                aria-pressed={on}
                onClick={() => setLanguages((s) => toggleLanguage(s, l.code))}
                className={`rounded-full border px-3 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-50 ${
                  on
                    ? "border-mantis-600 bg-mantis-600 text-white"
                    : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]"
                }`}
              >
                {l.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-[#777]">Language data downloads the first time from this site, then stays in your browser.</p>
        <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={skipText}
            onChange={(e) => setSkipText(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          Skip pages that already contain text
        </label>
      </fieldset>

      {progress && (
        <div className="mt-6">
          {/* Announced only when the page count changes; the status and ETA below are visual. */}
          <p className="sr-only" role="status" aria-live="polite">
            {progress.done} of {progress.total} pages done
          </p>
          <div className="flex items-center justify-between text-sm text-gray-700 dark:text-[#aaa]" aria-hidden="true">
            <span>
              {progress.status} ({progress.done} of {progress.total} done)
            </span>
            <span>{progress.recognised > 0 ? eta : ""}</span>
          </div>
          <div
            role="progressbar"
            aria-label="OCR progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            className="mt-2 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-[#222]"
          >
            <div className="h-full bg-mantis-600 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {summary && result && (
        <div role="status" className="mt-6 rounded-lg border border-mantis-300 bg-mantis-50 p-3 text-sm text-mantis-900 dark:border-mantis-800 dark:bg-[#0f1a0f] dark:text-mantis-200">
          <p className="font-medium">{summaryHeadline(summary)}</p>
          <ul className="mt-1 list-disc pl-5">
            {summary.averageConfidence !== null && <li>Average confidence: {Math.round(summary.averageConfidence)}%.</li>}
            {summary.skipped.length > 0 && (
              <li>{skippedLine(summary.skipped)}</li>
            )}
            {summary.lowQuality.length > 0 && (
              <li>
                Low quality scan, check the result: {summary.lowQuality.length === 1 ? "page" : "pages"} {summary.lowQuality.join(", ")}. A
                sideways scan reads as low quality:{" "}
                {/* A new tab: leaving this page would lose the recognised text. */}
                <Link to="/rotate" target="_blank" rel="noopener" className={linkClass}>
                  Rotate pages
                </Link>
                , then run OCR again.
              </li>
            )}
            {summary.noText.length > 0 && (
              <li>
                No text found: {summary.noText.length === 1 ? "page" : "pages"} {summary.noText.join(", ")}.
              </li>
            )}
            {result.failed.length > 0 && <li>{failedLine(result.failed)}</li>}
            {alreadyOcr.length > 0 && <li>{alreadyOcrLine(alreadyOcr)}</li>}
          </ul>
        </div>
      )}

      <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />

      <div className="mt-6 flex flex-wrap gap-3">
        {running ? (
          <button type="button" onClick={cancel} className={secondaryButton}>
            Cancel
          </button>
        ) : result ? (
          <>
            <button type="button" onClick={downloadPdf} disabled={busy || result.layer.length === 0} className={primaryButton}>
              {busy ? "Saving…" : "Download searchable PDF"}
            </button>
            <button type="button" onClick={downloadText} disabled={result.texts.length === 0} className={secondaryButton}>
              Download text
            </button>
            <button type="button" onClick={() => void runOcr()} className={secondaryButton}>
              Run again
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void runOcr()} disabled={busy} className={primaryButton}>
            Run OCR
          </button>
        )}
        <button type="button" onClick={startOver} className={secondaryButton}>
          Choose another file
        </button>
      </div>

      <p className="mt-4 text-xs text-gray-500 dark:text-[#777]">
        Run OCR first to redact scanned documents by search.{" "}
        {/* A new tab: leaving this page would lose the recognised text and any run in progress. */}
        <Link to="/redact" target="_blank" rel="noopener" className={linkClass}>
          Redact PDF
        </Link>
      </p>
    </div>
  );
}

export default function OcrPage() {
  const worker = usePdfWorker();
  const { pageSizes, addTextLayer } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  return (
    <ToolShell
      title="OCR PDF: Make Scanned PDFs Searchable | MantisPDF"
      description="Recognise the text of scanned PDFs in your browser and add it as a searchable, copyable text layer. Free, private, nothing is uploaded."
      path="/ocr"
      heading="OCR PDF"
      intro="Make scanned PDFs searchable and copyable. The text is recognised on your device; nothing is uploaded."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => void pick(f)} error={error} engineReady={worker.ready} />
        </div>
      )}

      {input && <Workspace input={input} busy={busy} run={run} error={error} setError={setError} addTextLayer={addTextLayer} onStartOver={reset} />}
    </ToolShell>
  );
}
