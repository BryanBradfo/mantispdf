import { useCallback, useState } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import OrganizeGrid from "../components/planner/OrganizeGrid";
import { buildPlan, usePagePlanner } from "../hooks/usePagePlanner";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import { encodePlan } from "../lib/pagePlan";
import { usePlannerUpload } from "./usePlannerUpload";
import { useDescribeError, useT, type UiError } from "../i18n";

export default function OrganizePdfPage() {
  const worker = usePdfWorker();
  const [state, dispatch] = usePagePlanner();
  const { addFiles, loading, cancel } = usePlannerUpload(worker, dispatch);
  const [busy, setBusy] = useState(false);
  const t = useT("organize");
  const tc = useT("common");
  const describe = useDescribeError();
  const [error, setError] = useState<UiError | null>(null);

  const { entries } = buildPlan(state, "organize");
  const pageCount = entries.length;

  const handleDownload = useCallback(async () => {
    const plan = buildPlan(state, "organize");
    if (plan.entries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      downloadBlob(await worker.applyPagePlan(plan.buffers, encodePlan(plan.entries)), "organized.pdf");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [state, worker, describe]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription")}
        path="/organize"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("intro")}
      </p>
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      <div className="mt-8">
        <DropZone multiple onFiles={addFiles} error={state.uploadError} />
      </div>
      {loading && (
        <div className="mt-6 flex items-center gap-3 text-gray-500 dark:text-[#555]">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent motion-reduce:animate-none" />
          {tc("loadingPdf")}
        </div>
      )}

      {state.items.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {t("pagesInResult", { count: pageCount })} · {t("files", { count: state.sources.length })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => dispatch({ type: "insert-blank", index: state.items.length })}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {t("addBlank")}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy || !worker.ready || pageCount === 0}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50"
              >
                {busy ? tc("processing") : t("downloadPdf")}
              </button>
              <button
                onClick={() => {
                  cancel();
                  dispatch({ type: "reset" });
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {tc("startOver")}
              </button>
            </div>
          </div>
          {pageCount === 0 && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t("needOnePage")}</p>
          )}
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6">
            <OrganizeGrid state={state} dispatch={dispatch} />
          </div>
        </>
      )}
    </div>
  );
}
