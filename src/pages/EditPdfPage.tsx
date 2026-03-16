import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Document } from "react-pdf";
import { PageSEO } from "../components/seo/PageSEO";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { useEditState } from "../hooks/useEditState";
import { validatePdfFile, readFileAsUint8Array, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import EditThumbnailGrid from "../components/edit/EditThumbnailGrid";

export default function EditPdfPage() {
  const worker = usePdfWorker();
  const { state, dispatch } = useEditState();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const handleFile = useCallback(
    async (f: File) => {
      const err = validatePdfFile(f);
      if (err) {
        dispatch({ type: "upload-error", message: err });
        return;
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setEditError(null);
      try {
        const pdfBytes = await readFileAsUint8Array(f);
        setBlobUrl(URL.createObjectURL(f));
        // numPages will be set once react-pdf reports document load
        dispatch({ type: "file-loaded", file: f, pdfBytes, numPages: 0 });
      } catch {
        dispatch({ type: "upload-error", message: "Failed to read file." });
      }
    },
    [blobUrl, dispatch],
  );

  const handleDocumentLoad = useCallback(
    ({ numPages }: { numPages: number }) => {
      if (!state.file || !state.pdfBytes) return;
      dispatch({
        type: "file-loaded",
        file: state.file,
        pdfBytes: state.pdfBytes,
        numPages,
      });
    },
    [state.file, state.pdfBytes, dispatch],
  );

  const handleDownload = useCallback(async () => {
    if (!state.pdfBytes || state.numPages === 0) return;
    const finalOrder = state.pageOrder.filter((p) => !state.deletedPages.has(p));
    if (finalOrder.length === 0) {
      setEditError("Cannot download: all pages are marked for deletion.");
      return;
    }
    setEditError(null);
    try {
      const result = await worker.editPages(state.pdfBytes, finalOrder);
      const outName = (state.file?.name ?? "document").replace(/\.pdf$/i, "") + "_edited.pdf";
      downloadBlob(new Uint8Array(result), outName);
      setDownloaded(true);
    } catch (err) {
      setEditError(String(err));
    }
  }, [state, worker]);

  const handleReset = useCallback(() => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setEditError(null);
    setDownloaded(false);
    dispatch({ type: "reset" });
  }, [blobUrl, dispatch]);

  const deletedCount = state.deletedPages.size;
  const hasChanges =
    deletedCount > 0 ||
    state.pageOrder.some((p, i) => p !== i + 1);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageSEO
        title="Edit PDF Pages — MantisPDF"
        description="Delete or reorder pages in a PDF online. Client-side processing, nothing is uploaded."
        path="/edit"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Edit Pages</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Delete unwanted pages or reorder them with the arrow buttons. All processing happens in your browser.
      </p>

      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!state.file ? (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={state.uploadError} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {state.file.name} — {state.numPages} page{state.numPages !== 1 ? "s" : ""}
              {deletedCount > 0 && (
                <span className="ml-2 font-medium text-red-600 dark:text-red-400">
                  ({deletedCount} marked for deletion)
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleDownload}
                disabled={worker.editing || !worker.ready || state.numPages === 0 || !hasChanges}
                className="rounded-lg bg-mantis-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                {worker.editing ? "Processing…" : "Download Edited PDF"}
              </button>
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-3 py-1.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  ← All tools
                </Link>
              )}
              <button
                onClick={handleReset}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                New file
              </button>
            </div>
          </div>

          <ErrorAlert error={editError} onDismiss={() => setEditError(null)} className="mt-4" />

          {state.numPages === 0 ? (
            <div className="mt-8 flex items-center justify-center py-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
              <span className="ml-3 text-gray-500 dark:text-[#555]">Loading PDF…</span>
              <Document file={blobUrl} onLoadSuccess={handleDocumentLoad} className="hidden">
                {null}
              </Document>
            </div>
          ) : (
            <div className="mt-6">
              <EditThumbnailGrid blobUrl={blobUrl!} state={state} dispatch={dispatch} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
