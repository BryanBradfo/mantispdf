import { useCallback, useEffect, useMemo, useState, type Dispatch } from "react";
import type { PlannerAction, PlannerSource } from "../hooks/usePagePlanner";
import { createUploadQueue } from "./uploadQueue";
import { isPdfFile, readFileAsUint8Array } from "../lib/fileHelpers";
import { UserError, useDescribeError, useT } from "../i18n";
import { useLatestRef } from "../hooks/useLatestRef";

interface Worker { ready: boolean; initError: string | null; countPages: (b: Uint8Array) => Promise<number> }

let nextSourceId = 0;

/** Read, count and add PDFs to the planner. Drops are queued in order; `cancel` discards pending work. */
export function usePlannerUpload(worker: Worker, dispatch: Dispatch<PlannerAction>) {
  const t = useT("common");
  // The queue is built once; it reads the current translation through refs so that a language
  // switch does not rebuild it (which would cancel pending uploads).
  const describeRef = useLatestRef(useDescribeError());
  const tRef = useLatestRef(t);
  const [loading, setLoading] = useState(false);
  const queue = useMemo(
    () =>
      createUploadQueue<PlannerSource[]>({
        onResult: (sources) => dispatch({ type: "sources-added", sources }),
        onError: (err) =>
          dispatch({ type: "upload-error", message: err instanceof Error ? describeRef.current(err) : tRef.current("readFailed") }),
        onPending: (count) => setLoading(count > 0),
      }),
    [dispatch, describeRef, tRef],
  );
  useEffect(() => () => queue.cancel(), [queue]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (worker.initError) {
        dispatch({ type: "upload-error", message: t("engineFailedReload") });
        return;
      }
      if (!worker.ready) {
        dispatch({ type: "upload-error", message: t("engineLoading") });
        return;
      }
      queue.enqueue(async () => {
        const sources: PlannerSource[] = [];
        for (const file of files) {
          if (!isPdfFile(file)) throw new UserError(t("fileProblem", { name: file.name, problem: t("invalidPdf") }));
          const bytes = await readFileAsUint8Array(file);
          const numPages = await worker.countPages(bytes);
          if (numPages <= 0) throw new UserError(t("fileProblem", { name: file.name, problem: t("readFailed") }));
          sources.push({ id: `s${++nextSourceId}`, file, bytes, numPages });
        }
        return sources;
      });
    },
    [worker, dispatch, queue, t],
  );

  return { addFiles, loading, cancel: queue.cancel };
}
