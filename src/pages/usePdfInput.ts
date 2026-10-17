import { useCallback, useState } from "react";
import { readFileAsUint8Array, validatePdfFile } from "../lib/fileHelpers";

interface EngineState { ready: boolean; initError: string | null }

export interface PdfInput {
  file: File;
  bytes: Uint8Array;
}

/** Validates, guards on engine state and reads one dropped PDF. Resolves to null (and sets `error`) on failure. */
export function usePdfInput(worker: EngineState) {
  const [input, setInput] = useState<PdfInput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(
    async (file: File): Promise<PdfInput | null> => {
      const invalid = validatePdfFile(file);
      if (invalid) {
        setError(invalid);
        return null;
      }
      if (worker.initError) {
        setError("PDF engine failed to load. Please reload the page.");
        return null;
      }
      if (!worker.ready) {
        setError("Engine is still loading, please wait a moment.");
        return null;
      }
      try {
        const bytes = await readFileAsUint8Array(file);
        const next = { file, bytes };
        setError(null);
        setInput(next);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to read this PDF.");
        return null;
      }
    },
    [worker.ready, worker.initError],
  );

  const reset = useCallback(() => {
    setInput(null);
    setError(null);
  }, []);

  return { input, error, setError, pick, reset };
}

export function baseName(file: File): string {
  return file.name.replace(/\.pdf$/i, "");
}
