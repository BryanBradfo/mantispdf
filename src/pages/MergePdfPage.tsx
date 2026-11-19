import { useCallback, useRef, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import ToolShell from "./ToolShell";
import { secondaryButton } from "../styles/ui";
import { useMergeState } from "../hooks/useMergeState";
import type { MergeFile } from "../hooks/useMergeState";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, readFileAsUint8Array, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import MergeFileList from "../components/merge/MergeFileList";
import MergeActions from "../components/merge/MergeActions";
import ProgressOverlay from "../components/common/ProgressOverlay";

let nextId = 0;

export default function MergePdfPage() {
  const [state, dispatch] = useMergeState();
  const worker = usePdfWorker();
  const t = useT("merge");
  const tc = useT("common");
  const describe = useDescribeError();
  const [mergeError, setMergeError] = useState<UiError | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!worker.ready) {
        dispatch({ type: "upload-error", error: tc("engineLoading") });
        return;
      }
      const newMergeFiles: MergeFile[] = [];
      for (const file of files) {
        if (!isPdfFile(file)) {
          dispatch({ type: "upload-error", error: tc("fileProblem", { name: file.name, problem: tc("invalidPdf") }) });
          return;
        }
        try {
          const bytes = await readFileAsUint8Array(file);
          const numPages = await worker.countPages(bytes);
          newMergeFiles.push({ id: String(++nextId), file, bytes, numPages });
        } catch {
          dispatch({ type: "upload-error", error: tc("readFailedNamed", { name: file.name }) });
          return;
        }
      }
      dispatch({ type: "files-added", files: newMergeFiles });
    },
    [dispatch, worker, tc],
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
      setMergeError(describe(err));
    }
  }, [worker, describe]);

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
    <ToolShell
      tool="merge"
      wide
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/merge"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      <div className="mt-8">
        <DropZone
          compact={state.files.length > 0}
          multiple
          onFiles={handleFiles}
          error={state.uploadError}
        />
      </div>

      {state.files.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
              {t("files", { count: state.files.length })} &middot; {t("totalPages", { count: totalPages })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {downloaded && (
                <Link to="/" className={secondaryButton}>
                  {tc("allTools")}
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
    </ToolShell>
  );
}
