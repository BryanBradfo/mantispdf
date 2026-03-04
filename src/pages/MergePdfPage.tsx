import { useCallback, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { useMergeState } from "../hooks/useMergeState";
import type { MergeFile } from "../hooks/useMergeState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, readFileAsUint8Array, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/split/DropZone";
import MergeFileList from "../components/merge/MergeFileList";
import MergeActions from "../components/merge/MergeActions";
import ProgressOverlay from "../components/split/ProgressOverlay";

// Ensure pdfjs worker is configured (also done in main.tsx)
if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
}

let nextId = 0;

export default function MergePdfPage() {
  const [state, dispatch] = useMergeState();
  const worker = usePdfWorker();
  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const newMergeFiles: MergeFile[] = [];
      for (const file of files) {
        const validationError = validatePdfFile(file);
        if (validationError) {
          dispatch({ type: "upload-error", error: `${file.name}: ${validationError}` });
          return;
        }
        try {
          const bytes = await readFileAsUint8Array(file);
          // Use pdfjs-dist to get the page count on the main thread
          const pdf = await getDocument({ data: bytes.slice() }).promise;
          newMergeFiles.push({
            id: String(++nextId),
            file,
            bytes,
            numPages: pdf.numPages,
          });
          pdf.destroy();
        } catch {
          dispatch({ type: "upload-error", error: `Failed to read ${file.name}.` });
          return;
        }
      }
      dispatch({ type: "files-added", files: newMergeFiles });
    },
    [dispatch],
  );

  const handleMerge = useCallback(async () => {
    if (state.files.length < 2) return;
    setMergeError(null);
    try {
      const buffers = state.files.map((f) => f.bytes);
      const merged = await worker.mergePdfs(buffers);
      downloadBlob(merged, "merged.pdf");
    } catch (err) {
      setMergeError(String(err));
    }
  }, [state.files, worker]);

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
      <h1 className="text-3xl font-bold text-gray-900">Merge PDF</h1>
      <p className="mt-2 text-gray-600">
        Upload multiple PDFs, drag to reorder, then merge into a single document.
      </p>

      {worker.initError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          WASM engine failed to load: {worker.initError}
        </div>
      )}

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
            <p className="text-sm text-gray-500">
              {state.files.length} file{state.files.length !== 1 ? "s" : ""} &middot;{" "}
              {totalPages} total page{totalPages !== 1 ? "s" : ""}
            </p>
            <MergeActions
              fileCount={state.files.length}
              onMerge={handleMerge}
              onReset={() => dispatch({ type: "reset" })}
              disabled={!worker.ready}
            />
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
