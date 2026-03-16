import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageSEO } from "../components/seo/PageSEO";
import { useMergeState } from "../hooks/useMergeState";
import type { MergeFile } from "../hooks/useMergeState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, readFileAsUint8Array, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import MergeFileList from "../components/merge/MergeFileList";
import MergeActions from "../components/merge/MergeActions";
import ProgressOverlay from "../components/common/ProgressOverlay";

let nextId = 0;

export default function MergePdfPage() {
  const [state, dispatch] = useMergeState();
  const worker = usePdfWorker();
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!worker.ready) {
        dispatch({ type: "upload-error", error: "Engine is still loading — please wait a moment." });
        return;
      }
      const newMergeFiles: MergeFile[] = [];
      for (const file of files) {
        const validationError = validatePdfFile(file);
        if (validationError) {
          dispatch({ type: "upload-error", error: `${file.name}: ${validationError}` });
          return;
        }
        try {
          const bytes = await readFileAsUint8Array(file);
          const numPages = await worker.countPages(bytes);
          newMergeFiles.push({ id: String(++nextId), file, bytes, numPages });
        } catch {
          dispatch({ type: "upload-error", error: `Failed to read ${file.name}.` });
          return;
        }
      }
      dispatch({ type: "files-added", files: newMergeFiles });
    },
    [dispatch, worker],
  );

  const filesRef = useRef(state.files);
  filesRef.current = state.files;

  const handleMerge = useCallback(async () => {
    if (filesRef.current.length < 2) return;
    setMergeError(null);
    try {
      const buffers = filesRef.current.map((f) => f.bytes);
      const merged = await worker.mergePdfs(buffers);
      downloadBlob(merged, "merged.pdf");
      setDownloaded(true);
    } catch (err) {
      setMergeError(String(err));
    }
  }, [worker]);

  const handleReset = useCallback(() => {
    dispatch({ type: "reset" });
    setDownloaded(false);
  }, [dispatch]);

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) =>
      dispatch({ type: "reorder", fromIndex, toIndex }),
    [dispatch],
  );

  const handleRemove = useCallback(
    (id: string) => dispatch({ type: "remove-file", id }),
    [dispatch],
  );

  const totalPages = state.files.reduce((sum, f) => sum + f.numPages, 0);
  const showOverlay = worker.merging || mergeError !== null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageSEO
        title="Merge PDF Files — MantisPDF"
        description="Combine multiple PDFs into one document. Drag to reorder pages. Free, private, no upload required."
        path="/merge"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Merge PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Upload multiple PDFs, drag to reorder, then merge into a single document.
      </p>

      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      <div className="mt-8">
        <DropZone
          multiple
          onFiles={handleFiles}
          error={state.uploadError}
        />
      </div>

      {state.files.length > 0 && (
        <>
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-[#555]">
              {state.files.length} file{state.files.length !== 1 ? "s" : ""} &middot;{" "}
              {totalPages} total page{totalPages !== 1 ? "s" : ""}
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
              <MergeActions
                fileCount={state.files.length}
                onMerge={handleMerge}
                onReset={handleReset}
                disabled={!worker.ready}
              />
            </div>
          </div>

          <div className="mt-4">
            <MergeFileList
              files={state.files}
              onReorder={handleReorder}
              onRemove={handleRemove}
            />
          </div>
        </>
      )}

      {showOverlay && (
        <ProgressOverlay
          progress={worker.progress}
          message={worker.progressMessage}
          error={mergeError}
          onDismissError={() => setMergeError(null)}
        />
      )}
    </div>
  );
}
