import { useCallback, useEffect, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import { PageSEO } from "../components/seo/PageSEO";
import { useSplitState } from "../hooks/useSplitState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, readFileAsArrayBuffer, readFileAsUint8Array } from "../lib/fileHelpers";
import { downloadAsZip } from "../lib/downloadZip";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ThumbnailGrid from "../components/split/ThumbnailGrid";
import SplitActions from "../components/split/SplitActions";
import ProgressOverlay from "../components/common/ProgressOverlay";

export default function SplitPdfPage() {
  const [state, dispatch] = useSplitState();
  const worker = usePdfWorker();
  const t = useT("split");
  const tc = useT("common");
  const describe = useDescribeError();
  const [splitError, setSplitError] = useState<UiError | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [isZipping, setIsZipping] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (!isPdfFile(file)) {
        dispatch({ type: "upload-error", error: tc("invalidPdf") });
        return;
      }
      // Dispatch immediately with just the File reference.
      // numPages is set later from the engine page count.
      dispatch({ type: "file-loaded", file, numPages: 0 });
    },
    [dispatch, tc],
  );

  // Source the page count from the WASM engine (lopdf) — the same library that
  // performs the split — so the page count the user sees and selects split points
  // against always matches what the split actually produces.
  const { ready: engineReady, countPages } = worker;
  useEffect(() => {
    if (!state.file || !engineReady || state.numPages > 0) return;
    let cancelled = false;
    const file = state.file;
    (async () => {
      try {
        const count = await countPages(await readFileAsUint8Array(file));
        if (cancelled) return;
        if (count > 0) dispatch({ type: "file-loaded", file, numPages: count });
        else dispatch({ type: "upload-error", error: tc("readFailed") });
      } catch {
        if (!cancelled) dispatch({ type: "upload-error", error: tc("readFailed") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.file, engineReady, state.numPages, countPages, dispatch, tc]);

  const handleSplit = useCallback(async () => {
    if (!state.file || state.splitPoints.size === 0) return;
    setSplitError(null);
    try {
      const arrayBuffer = await readFileAsArrayBuffer(state.file);
      const parts = await worker.splitPdf(arrayBuffer, Array.from(state.splitPoints));
      setIsZipping(true);
      const baseName = state.file.name.replace(/\.pdf$/i, "") ?? "document";
      await downloadAsZip(parts, baseName);
      setIsZipping(false);
      setDownloaded(true);
    } catch (err) {
      setIsZipping(false);
      setSplitError(describe(err));
    }
  }, [state.file, state.splitPoints, worker, describe]);

  const handleToggleSplit = useCallback(
    (page: number) => dispatch({ type: "toggle-split", page }),
    [dispatch],
  );

  const showOverlay = worker.splitting || isZipping || splitError !== null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription")}
        path="/split"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("intro")}
      </p>

      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!state.file ? (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={state.uploadError} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {tc("fileWithPages", { name: state.file?.name ?? "", count: state.numPages })}
            </p>
            <div className="flex items-center gap-3">
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-3 py-1.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  {tc("allTools")}
                </Link>
              )}
              <SplitActions
                splitCount={state.splitPoints.size}
                onSplit={handleSplit}
                onReset={() => { dispatch({ type: "reset" }); setDownloaded(false); }}
                disabled={!worker.ready}
              />
            </div>
          </div>

          {state.numPages > 0 ? (
            <div className="mt-6">
              <ThumbnailGrid
                source={state.file!}
                numPages={state.numPages}
                splitPoints={state.splitPoints}
                onToggleSplit={handleToggleSplit}
              />
            </div>
          ) : (
            <div className="mt-8 flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
              <span className="ml-3 text-gray-500 dark:text-[#555]">{tc("loadingPdf")}</span>
            </div>
          )}
        </>
      )}

      {showOverlay && (
        <ProgressOverlay
          progress={worker.progress}
          message={worker.progressMessage}
          error={splitError}
          onDismissError={() => setSplitError(null)}
        />
      )}
    </div>
  );
}
