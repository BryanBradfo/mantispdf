// src/pages/SelectPagesTool.tsx
import { useCallback, useMemo, useState } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import RangeInput from "../components/planner/RangeInput";
import SelectGrid from "../components/planner/SelectGrid";
import { buildPlan, usePagePlanner } from "../hooks/usePagePlanner";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadAsZip } from "../lib/downloadZip";
import { downloadBlob } from "../lib/fileHelpers";
import { encodePlan } from "../lib/pagePlan";
import { usePlannerUpload } from "./usePlannerUpload";
import { useDescribeError, useT, type UiError } from "../i18n";

/** Download-name suffix per mode (file names stay English). */
const SUFFIX = { remove: "_removed", extract: "_extracted" } as const;
/** English paths; PageSEO derives the localized URL. */
const PATH = { remove: "/remove-pages", extract: "/extract-pages" } as const;

export default function SelectPagesTool({ mode }: { mode: "remove" | "extract" }) {
  // Both namespaces have the same keys; picking one by mode keeps the typed `t`.
  const t = useT(mode === "remove" ? "removePages" : "extractPages");
  const tp = useT("pages");
  const tc = useT("common");
  const describe = useDescribeError();
  const suffix = SUFFIX[mode];
  const worker = usePdfWorker();
  const [state, dispatch] = usePagePlanner();
  const { addFiles, loading, cancel } = usePlannerUpload(worker, dispatch);
  const [perPage, setPerPage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  const source = state.sources[0];
  const total = source?.numPages ?? 0;
  const selectedPages = useMemo(
    () => state.items.filter((i) => i.kind === "page" && state.selected.has(i.id)).map((i) => (i.kind === "page" ? i.page : 0)),
    [state.items, state.selected],
  );
  const resultCount = buildPlan(state, mode).entries.length;
  const baseName = (source?.file.name ?? "document").replace(/\.pdf$/i, "");

  const setPages = useCallback(
    (pages: number[]) => {
      const wanted = new Set(pages);
      dispatch({ type: "set-selection", ids: state.items.filter((i) => i.kind === "page" && wanted.has(i.page)).map((i) => i.id) });
    },
    [dispatch, state.items],
  );

  const handleDownload = useCallback(async () => {
    const plan = buildPlan(state, mode);
    if (plan.entries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await worker.applyPagePlan(plan.buffers, encodePlan(plan.entries));
      if (mode === "extract" && perPage && plan.entries.length > 1) {
        const after = plan.entries.slice(0, -1).map((_, i) => i + 1);
        const parts = await worker.splitPdf(bytes.slice().buffer as ArrayBuffer, after);
        const pageNumbers = plan.entries.map((e) => (e.kind === "page" ? e.page : 0));
        await downloadAsZip(parts.map((p, i) => ({ ...p, name: `${baseName}_page_${pageNumbers[i]}.pdf` })), baseName, "pages");
      } else {
        downloadBlob(bytes, `${baseName}${suffix}.pdf`);
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [state, mode, perPage, worker, baseName, suffix, describe]);

  const nothingChosen = selectedPages.length === 0;
  const disabled = busy || !worker.ready || resultCount === 0 || (mode === "remove" && nothingChosen);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageSEO title={t("seoTitle")} description={t("seoDescription")} path={PATH[mode]} />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">{t("intro")} {tp("everythingLocal")}</p>
      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!source ? (
        <div className="mt-8">
          {loading ? (
            <div className="flex items-center gap-3 py-12 text-gray-500 dark:text-[#555]">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent motion-reduce:animate-none" />
              {tc("loadingPdf")}
            </div>
          ) : (
            <DropZone onFile={(f) => addFiles([f])} error={state.uploadError} />
          )}
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
            <RangeInput label={t("rangeLabel")} total={total} selectedPages={selectedPages} onPages={setPages} />
            <div className="flex flex-wrap items-center gap-3">
              {mode === "extract" && (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
                  <input type="checkbox" checked={perPage} onChange={(e) => setPerPage(e.target.checked)} />
                  {tp("perPageZip")}
                </label>
              )}
              <button
                onClick={handleDownload}
                disabled={disabled}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50"
              >
                {busy ? tc("processing") : tc("download")}
              </button>
              <button
                onClick={() => {
                  cancel();
                  dispatch({ type: "reset" });
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {tc("newFile")}
              </button>
            </div>
          </div>
          <p className="mt-3 text-sm text-gray-500 dark:text-[#555]">
            {tp("resultOf", { name: source.file.name, result: resultCount, count: total })}
            {mode === "remove" && resultCount === 0 && <span className="ml-2 text-red-600 dark:text-red-400">{tp("mustRemain")}</span>}
          </p>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6">
            <SelectGrid state={state} dispatch={dispatch} mode={mode} />
          </div>
        </>
      )}
    </div>
  );
}
