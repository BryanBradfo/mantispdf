import { useCallback, useRef, useState, type Dispatch } from "react";
import type { PlannerAction, PlannerSource } from "../hooks/usePagePlanner";
import { readFileAsUint8Array, validatePdfFile } from "../lib/fileHelpers";

interface Worker { ready: boolean; initError: string | null; countPages: (b: Uint8Array) => Promise<number> }

let nextSourceId = 0;

/** Read, count and add PDFs to the planner; ignores results of a superseded upload. */
export function usePlannerUpload(worker: Worker, dispatch: Dispatch<PlannerAction>) {
  const [loading, setLoading] = useState(false);
  const token = useRef(0);

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
      const mine = ++token.current;
      setLoading(true);
      try {
        const sources: PlannerSource[] = [];
        for (const file of files) {
          const invalid = validatePdfFile(file);
          if (invalid) throw new Error(`${file.name}: ${invalid}`);
          const bytes = await readFileAsUint8Array(file);
          const numPages = await worker.countPages(bytes);
          if (numPages <= 0) throw new Error(`${file.name}: Failed to read this PDF.`);
          sources.push({ id: `s${++nextSourceId}`, file, bytes, numPages });
        }
        if (mine === token.current) dispatch({ type: "sources-added", sources });
      } catch (err) {
        if (mine === token.current) {
          dispatch({ type: "upload-error", message: err instanceof Error ? err.message : "Failed to read this PDF." });
        }
      } finally {
        if (mine === token.current) setLoading(false);
      }
    },
    [worker, dispatch],
  );

  return { addFiles, loading };
}
