import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageSEO } from "../components/seo/PageSEO";
import { useSplitState } from "../hooks/useSplitState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, readFileAsArrayBuffer } from "../lib/fileHelpers";
import { downloadAsZip } from "../lib/downloadZip";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ThumbnailGrid from "../components/split/ThumbnailGrid";
import SplitActions from "../components/split/SplitActions";
import ProgressOverlay from "../components/common/ProgressOverlay";
import { Document } from "react-pdf";

export default function SplitPdfPage() {
  const [state, dispatch] = useSplitState();
  const worker = usePdfWorker();
  const [splitError, setSplitError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [isZipping, setIsZipping] = useState(false);

  // Create a stable Blob URL for react-pdf directly from the File reference.
  // This avoids loading the entire file into JS heap just for thumbnail rendering.
  const pdfUrl = useMemo(() => {
    if (!state.file) return null;
    return URL.createObjectURL(state.file);
  }, [state.file]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const handleFile = useCallback(
    (file: File) => {
      const validationError = validatePdfFile(file);
      if (validationError) {
        dispatch({ type: "upload-error", error: validationError });
        return;
      }
      // Dispatch immediately with just the File reference.
      // numPages is set later via react-pdf's onLoadSuccess.
      dispatch({ type: "file-loaded", file, numPages: 0 });
    },
    [dispatch],
  );

  const handleDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }) => {
      if (state.file) {
        dispatch({ type: "file-loaded", file: state.file, numPages });
      }
    },
    [dispatch, state.file],
  );

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
      setSplitError(String(err));
    }
  }, [state.file, state.splitPoints, worker]);

  const handleToggleSplit = useCallback(
    (page: number) => dispatch({ type: "toggle-split", page }),
    [dispatch],
  );

  const showOverlay = worker.splitting || isZipping || splitError !== null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageSEO
        title="Split PDF Online — MantisPDF"
        description="Split a PDF into multiple files instantly. Choose exact split points. Runs in your browser, no upload needed."
        path="/split"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Split PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Upload a PDF, click the scissors between pages to mark split points, then hit Split.
      </p>

      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!state.file ? (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={state.uploadError} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {state.file?.name} — {state.numPages} page{state.numPages !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-3">
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-3 py-1.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  ← All tools
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
                pdfUrl={pdfUrl!}
                numPages={state.numPages}
                splitPoints={state.splitPoints}
                onToggleSplit={handleToggleSplit}
              />
            </div>
          ) : (
            // Hidden Document just to get numPages via onLoadSuccess
            <div className="mt-8 flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
              <span className="ml-3 text-gray-500 dark:text-[#555]">Loading PDF…</span>
              <Document
                file={pdfUrl}
                onLoadSuccess={handleDocumentLoad}
                className="hidden"
              >
                {null}
              </Document>
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
