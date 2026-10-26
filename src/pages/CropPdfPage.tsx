import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Trans, useLocale, useT } from "../i18n";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageImage from "../components/common/PageImage";
import RangeInput from "../components/planner/RangeInput";
import LiveSummary from "../components/stamp/LiveSummary";
import CropCanvas from "../components/geometry/CropCanvas";
import { detectContentRects } from "../lib/autoMargins";
import { buildCropJob, cropTargetPages, defaultCropRect, fitCropToPage, missedPagesProblem, pagesMissedBy, type CropScope } from "../lib/cropBox";
import type { Rect } from "../lib/geometryJob";
import { describePages } from "../lib/stampBuilders";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

/** The engine accepts at most this many per-page boxes in one job. */
const MAX_PER_PAGE = 10_000;

const SCOPES: readonly CropScope[] = ["this", "all", "range"];

export default function CropPdfPage() {
  const t = useT("crop");
  const tc = useT("common");
  const tp = useT("pages");
  const tg = useT("geometry");
  const locale = useLocale();
  const worker = usePdfWorker();
  const { pageSizes } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const [page, setPage] = useState(1);
  /** The one box shared by scopes this / all / range (null until the user moves it). */
  const [rect, setRect] = useState<Rect | null>(null);
  const [scope, setScope] = useState<CropScope>("all");
  const [range, setRange] = useState<number[] | null>(null);
  const [permanent, setPermanent] = useState(false);
  /** Boxes from "Auto-detect margins" on all pages, one per page. */
  const [perPage, setPerPage] = useState<Map<number, Rect> | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  /** The latest `perPage`, for a detection that finishes after the mode changed. */
  const perPageRef = useRef(perPage);
  useEffect(() => {
    perPageRef.current = perPage;
  }, [perPage]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const sizes = useMemo(() => input?.data ?? [], [input]);
  const total = sizes.length;
  const pageSize = sizes[page - 1] ?? null;
  const selected = useMemo(() => range ?? Array.from({ length: total }, (_, i) => i + 1), [range, total]);

  const shown: Rect | null = useMemo(
    () => (pageSize ? perPage?.get(page) ?? fitCropToPage(rect ?? defaultCropRect(pageSize), pageSize) : null),
    [pageSize, perPage, page, rect],
  );

  const onRect = (next: Rect) => {
    setNotice("");
    if (perPage) setPerPage(new Map(perPage).set(page, next));
    else setRect(next);
  };

  const stopDetection = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDetecting(false);
    setProgress(null);
  };

  const detect = (all: boolean) => {
    if (!input || busy) return;
    if (all && total > MAX_PER_PAGE) {
      setError(t("autoTooMany", { max: MAX_PER_PAGE }));
      return;
    }
    stopDetection();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const pages = all ? Array.from({ length: total }, (_, i) => i + 1) : [page];
    const shownPage = page;
    setDetecting(true);
    setNotice("");
    setProgress(all ? { done: 0, total: pages.length } : null);
    const onProgress = (done: number, of: number) => {
      if (!ctrl.signal.aborted) setProgress({ done, total: of });
    };
    void run(
      () =>
        detectContentRects(input.bytes, pages, sizes, { onProgress, signal: ctrl.signal }).finally(() => {
          if (abortRef.current !== ctrl) return;
          abortRef.current = null;
          setDetecting(false);
          setProgress(null);
        }),
      (found) => {
        if (all) {
          setPerPage(found);
          setNotice(t("detectedAll", { count: found.size }));
          return;
        }
        const box = found.get(shownPage);
        if (!box) return;
        if (perPageRef.current) setPerPage((cur) => (cur ? new Map(cur).set(shownPage, box) : cur));
        else setRect(box);
        setNotice(t("detectedOne", { page: shownPage }));
      },
    );
  };

  // A shared box on pages of other sizes may not reach some of them.
  const missed = useMemo(
    () =>
      !perPage && shown && scope !== "this"
        ? pagesMissedBy(shown, sizes, cropTargetPages({ scope, page, range: selected, total }))
        : [],
    [perPage, shown, scope, page, sizes, selected, total],
  );

  const problem =
    perPage ? (perPage.size > MAX_PER_PAGE ? t("autoTooManyShort", { max: MAX_PER_PAGE }) : null)
    : scope === "range" && selected.length === 0 ? tg("selectAtLeastOne")
    : missedPagesProblem(missed, t);

  const r = Math.round;
  const target =
    scope === "this"
      ? t("targetPage", { page })
      : scope === "all"
        ? t("targetAll")
        : describePages(selected, total, tp).toLocaleLowerCase(locale);
  const permanentTag = permanent ? ` · ${t("permanentTag")}` : "";
  const summary = perPage
    ? t("summaryPerPage", { count: perPage.size }) + permanentTag
    : shown
      ? t("summaryBox", { width: r(shown[2]), height: r(shown[3]), target }) + permanentTag
      : "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy || problem || !shown) return;
    const job = buildCropJob({ scope, page, rect: shown, range: selected, total, perPage, permanent });
    void run(
      () => worker.cropPdf(input.bytes, job),
      (out) => downloadBlob(out, `${baseName(input.file)}_cropped.pdf`),
    );
  };

  const clearChoices = () => {
    stopDetection();
    setPage(1);
    setRect(null);
    setScope("all");
    setRange(null);
    setPerPage(null);
    setNotice("");
  };

  const clear = () => {
    reset();
    clearChoices();
  };

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/crop"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { clearChoices(); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
            {tc("fileWithPagesParen", { name: input.file.name, count: total })}
          </p>

          {total > 1 && (
            <div className="mt-4 flex gap-2 overflow-x-auto pb-2" role="group" aria-label={tc("pagesGroup")}>
              {sizes.map((_, i) => {
                const n = i + 1;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-label={tc("pageN", { n })}
                    aria-pressed={page === n}
                    disabled={detecting}
                    onClick={() => setPage(n)}
                    className={`w-20 shrink-0 overflow-hidden rounded-md border-2 bg-white text-xs disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[#111] ${
                      page === n ? "border-mantis-600" : "border-transparent hover:border-gray-300 dark:hover:border-[#444]"
                    }`}
                  >
                    <PageImage source={input.file} page={n} width={80} alt="" />
                    <span className="block py-0.5 text-gray-700 dark:text-[#aaa]">{n}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4">
            {pageSize && shown && (
              <CropCanvas source={input.file} page={page} pageSize={pageSize} rect={shown} onRect={onRect} />
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => detect(false)} disabled={busy} className={secondaryButton}>
              {t("autoThis")}
            </button>
            <button type="button" onClick={() => detect(true)} disabled={busy} className={secondaryButton}>
              {t("autoAll")}
            </button>
          </div>
          {progress && (
            <div className="mt-3">
              <progress
                value={progress.done}
                max={progress.total}
                aria-label={t("detecting")}
                className="h-2 w-full max-w-sm overflow-hidden rounded-full accent-mantis-600"
              />
              <p className="mt-1 text-xs text-gray-600 dark:text-[#888]">
                {t("detectingProgress", { done: progress.done, total: progress.total })}
              </p>
            </div>
          )}
          <p role="status" className="mt-2 text-xs text-gray-600 dark:text-[#888]">{notice}</p>

          {perPage ? (
            <div className="mt-4 text-sm text-gray-700 dark:text-[#aaa]">
              <p>{t("perPageNote")}</p>
              <button
                type="button"
                disabled={detecting}
                onClick={() => { setPerPage(null); setNotice(""); }}
                className={`mt-2 disabled:opacity-60 ${secondaryButton}`}
              >
                {t("useOneBox")}
              </button>
            </div>
          ) : (
            <fieldset className="mt-4" disabled={detecting}>
              <legend className="text-sm text-gray-700 dark:text-[#aaa]">{t("applyTo")}</legend>
              <div className="mt-1 flex flex-wrap gap-4 text-sm text-gray-700 dark:text-[#aaa]">
                {SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2">
                    <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
                    {s === "this" ? t("scopeThis", { page }) : s === "all" ? t("scopeAll") : t("scopeRange")}
                  </label>
                ))}
              </div>
              {scope === "range" && (
                <div className="mt-3">
                  <RangeInput label={t("rangeLabel")} total={total} selectedPages={selected} onPages={setRange} />
                </div>
              )}
            </fieldset>
          )}

          <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
            <input
              type="checkbox"
              checked={permanent}
              onChange={(e) => setPermanent(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
            />
            {t("makePermanent")}
          </label>

          <p className="mt-4 rounded-lg bg-white/70 p-3 text-xs text-gray-600 dark:bg-[#111] dark:text-[#888]">
            <Trans
              ns="crop"
              k="hiddenNote"
              components={{
                link: (c) => (
                  <Link to="/sanitize" className="font-medium text-mantis-700 underline dark:text-mantis-400">
                    {c}
                  </Link>
                ),
              }}
            />
          </p>

          <LiveSummary text={summary} className="mt-4 text-sm text-gray-600 dark:text-[#888]" />

          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || problem !== null || !shown} className={`flex-1 ${primaryButton}`}>
              {busy && !detecting ? t("cropping") : t("submit")}
            </button>
            <button type="button" onClick={clear} className={secondaryButton}>{tc("chooseAnother")}</button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
