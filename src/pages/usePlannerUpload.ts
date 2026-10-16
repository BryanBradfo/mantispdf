import { useCallback, useEffect, useMemo, useState, type Dispatch } from "react";
import type { PlannerAction, PlannerSource } from "../hooks/usePagePlanner";
import { createUploadQueue } from "./uploadQueue";
import { readFileAsUint8Array, validatePdfFile } from "../lib/fileHelpers";

interface Worker { ready: boolean; initError: string | null; countPages: (b: Uint8Array) => Promise<number> }

let nextSourceId = 0;

/** Read, count and add PDFs to the planner. Drops are queued in order; `cancel` discards pending work. */
export function usePlannerUpload(worker: Worker, dispatch: Dispatch<PlannerAction>) {
  const [loading, setLoading] = useState(false);
  const queue = useMemo(
    () =>
      createUploadQueue<PlannerSource[]>({
        onResult: (sources) => dispatch({ type: "sources-added", sources }),
        onError: (err) =>
          dispatch({ type: "upload-error", message: err instanceof Error ? err.message : "Failed to read this PDF." }),
        onPending: (count) => setLoading(count > 0),
      }),
    [dispatch],
  );
  useEffect(() => () => queue.cancel(), [queue]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (worker.initError) {
        dispatch({ type: "upload-error", message: "PDF engine failed to load. Please reload the page." });
        return;
      }
      if (!worker.ready) {
        dispatch({ type: "upload-error", message: "Engine is still loading, please wait a moment." });
        return;
      }
      queue.enqueue(async () => {
        const sources: PlannerSource[] = [];
        for (const file of files) {
          const invalid = validatePdfFile(file);
          if (invalid) throw new Error(`${file.name}: ${invalid}`);
          const bytes = await readFileAsUint8Array(file);
          const numPages = await worker.countPages(bytes);
          if (numPages <= 0) throw new Error(`${file.name}: Failed to read this PDF.`);
          sources.push({ id: `s${++nextSourceId}`, file, bytes, numPages });
        }
        return sources;
      });
    },
    [worker, dispatch, queue],
  );

  return { addFiles, loading, cancel: queue.cancel };
}
