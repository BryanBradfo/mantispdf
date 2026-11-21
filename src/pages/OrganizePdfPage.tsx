import MetaItems from "../components/common/MetaItems";
import { useCallback, useState } from "react";
import ToolShell from "./ToolShell";
import LoadingRow from "../components/common/LoadingRow";
import { monoLabel, primaryButton, secondaryButton } from "../styles/ui";
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
    <ToolShell
      tool="organize"
      wide
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/organize"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      <div className="mt-8">
        <DropZone compact={state.items.length > 0} multiple onFiles={addFiles} error={state.uploadError} />
      </div>
      {loading && <LoadingRow label={tc("loadingPdf")} className="mt-6" />}

      {state.items.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <p className={monoLabel}>
              <MetaItems className="!justify-start">
                {t("pagesInResult", { count: pageCount })}
                {t("files", { count: state.sources.length })}
              </MetaItems>
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => dispatch({ type: "insert-blank", index: state.items.length })}
                className={secondaryButton}
              >
                {t("addBlank")}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy || !worker.ready || pageCount === 0}
                className={primaryButton}
              >
                {busy ? tc("processing") : t("downloadPdf")}
              </button>
              <button
                onClick={() => {
                  cancel();
                  dispatch({ type: "reset" });
                }}
                className={secondaryButton}
              >
                {tc("startOver")}
              </button>
            </div>
          </div>
          {pageCount === 0 && (
            <p className="mt-3 text-sm text-danger">{t("needOnePage")}</p>
          )}
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6">
            <OrganizeGrid state={state} dispatch={dispatch} />
          </div>
        </>
      )}
    </ToolShell>
  );
}
