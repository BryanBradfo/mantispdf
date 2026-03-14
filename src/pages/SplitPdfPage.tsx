import { useCallback, useEffect, useMemo, useState } from "react";
import { PageSEO } from "../components/seo/PageSEO";
import { useSplitState } from "../hooks/useSplitState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, readFileAsUint8Array } from "../lib/fileHelpers";
import { downloadAsZip } from "../lib/downloadZip";
import DropZone from "../components/split/DropZone";
import ThumbnailGrid from "../components/split/ThumbnailGrid";
import SplitActions from "../components/split/SplitActions";
import ProgressOverlay from "../components/split/ProgressOverlay";
import { Document } from "react-pdf";

export default function SplitPdfPage() {
  const [state, dispatch] = useSplitState();
  const worker = usePdfWorker();
  const [splitError, setSplitError] = useState<string | null>(null);

  // Create a stable Blob URL for react-pdf to avoid ArrayBuffer detachment.
  // pdf.js transfers the underlying ArrayBuffer to its worker, which would
  // detach it and break subsequent renders. A Blob URL sidesteps this.
  const pdfUrl = useMemo(() => {
    if (!state.pdfBytes) return null;
    return URL.createObjectURL(
      new Blob([state.pdfBytes], { type: "application/pdf" }),
    );
  }, [state.pdfBytes]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const handleFile = useCallback(
    async (file: File) => {
      const validationError = validatePdfFile(file);
      if (validationError) {
        dispatch({ type: "upload-error", error: validationError });
        return;
      }
      try {
        const bytes = await readFileAsUint8Array(file);
        // We'll get the page count from react-pdf's onLoadSuccess
        // Store bytes and file now, numPages set via onLoadSuccess
        dispatch({ type: "file-loaded", file, pdfBytes: bytes, numPages: 0 });
      } catch {
        dispatch({ type: "upload-error", error: "Failed to read file." });
      }
    },
    [dispatch],
  );

  const handleDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }) => {
      if (state.file && state.pdfBytes) {
        dispatch({
          type: "file-loaded",
          file: state.file,
          pdfBytes: state.pdfBytes,
          numPages,
        });
      }
    },
    [dispatch, state.file, state.pdfBytes],
  );

  const handleSplit = useCallback(async () => {
    if (!state.pdfBytes || state.splitPoints.size === 0) return;
    setSplitError(null);
    try {
      const parts = await worker.splitPdf(
        state.pdfBytes,
        Array.from(state.splitPoints),
      );
      const baseName = state.file?.name.replace(/\.pdf$/i, "") ?? "document";
      await downloadAsZip(parts, baseName);
    } catch (err) {
      setSplitError(String(err));
    }
  }, [state.pdfBytes, state.splitPoints, state.file, worker]);

  const handleToggleSplit = useCallback(
    (page: number) => dispatch({ type: "toggle-split", page }),
    [dispatch],
  );

  const showOverlay = worker.splitting || splitError !== null;

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

      {worker.initError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          WASM engine failed to load: {worker.initError}
        </div>
      )}

      {!state.pdfBytes ? (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={state.uploadError} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {state.file?.name} — {state.numPages} page{state.numPages !== 1 ? "s" : ""}
            </p>
            <SplitActions
              splitCount={state.splitPoints.size}
              onSplit={handleSplit}
              onReset={() => dispatch({ type: "reset" })}
              disabled={!worker.ready}
            />
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
