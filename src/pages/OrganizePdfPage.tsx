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

export default function OrganizePdfPage() {
  const worker = usePdfWorker();
  const [state, dispatch] = usePagePlanner();
  const { addFiles, loading, cancel } = usePlannerUpload(worker, dispatch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [state, worker]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageSEO
        title="Organize PDF Pages | MantisPDF"
        description="Reorder, rotate, duplicate, delete and insert blank pages across several PDFs. Free, private, nothing is uploaded."
        path="/organize"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Organize PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Drop one or more PDFs, then drag pages into place, rotate, duplicate, delete or add blank pages.
      </p>
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      <div className="mt-8">
        <DropZone multiple onFiles={addFiles} error={state.uploadError} />
      </div>
      {loading && (
        <div className="mt-6 flex items-center gap-3 text-gray-500 dark:text-[#555]">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent motion-reduce:animate-none" />
          Loading PDF…
        </div>
      )}

      {state.items.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {pageCount} page{pageCount !== 1 ? "s" : ""} in the result · {state.sources.length} file{state.sources.length !== 1 ? "s" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => dispatch({ type: "insert-blank", index: state.items.length })}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                Add blank page
              </button>
              <button
                onClick={handleDownload}
                disabled={busy || !worker.ready || pageCount === 0}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50"
              >
                {busy ? "Processing…" : "Download PDF"}
              </button>
              <button
                onClick={() => {
                  cancel();
                  dispatch({ type: "reset" });
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                Start over
              </button>
            </div>
          </div>
          {pageCount === 0 && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">Add at least one page from a document to download.</p>
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
