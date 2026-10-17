import { useCallback, useMemo, useState } from "react";
import { readFileAsUint8Array, validatePdfFile } from "../lib/fileHelpers";
import { createLatest } from "../lib/latest";

interface EngineState { ready: boolean; initError: string | null }

export interface PdfInput<T = undefined> {
  file: File;
  bytes: Uint8Array;
  /** Result of the optional `prepare` step (e.g. metadata), always paired with these exact bytes. */
  data: T;
}

export function baseName(file: File): string {
  return file.name.replace(/\.pdf$/i, "");
}

/**
 * Validates, guards on engine state and reads one dropped PDF. `prepare` runs before the file is accepted;
 * a failure there is shown as the error and leaves no file selected. Every async step is superseded by a
 * newer pick, `reset` or `run`, so stale results are ignored.
 */
export function usePdfInput<T = undefined>(worker: EngineState, prepare?: (bytes: Uint8Array) => Promise<T>) {
  const [input, setInput] = useState<PdfInput<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useMemo(createLatest, []);

  const pick = useCallback(
    async (file: File): Promise<void> => {
      const current = latest.begin();
      setBusy(false);
      setInput(null);
      const invalid = validatePdfFile(file);
      if (invalid) return setError(invalid);
      if (worker.initError) return setError("PDF engine failed to load. Please reload the page.");
      if (!worker.ready) return setError("Engine is still loading, please wait a moment.");
      try {
        const bytes = await readFileAsUint8Array(file);
        const data = (prepare ? await prepare(bytes) : undefined) as T;
        if (!current()) return;
        setError(null);
        setInput({ file, bytes, data });
      } catch (err) {
        if (current()) setError(err instanceof Error ? err.message : String(err));
      }
    },
    [worker.ready, worker.initError, prepare, latest],
  );

  const reset = useCallback(() => {
    latest.invalidate();
    setInput(null);
    setError(null);
    setBusy(false);
  }, [latest]);

  const update = useCallback((data: T) => setInput((cur) => (cur ? { ...cur, data } : cur)), []);

  /** Run `work`, then `done` with its result, unless a newer pick/reset/run superseded it. */
  const run = useCallback(
    async <R,>(work: () => Promise<R>, done: (result: R) => void): Promise<void> => {
      const current = latest.begin();
      setBusy(true);
      setError(null);
      try {
        const result = await work();
        if (current()) done(result);
      } catch (err) {
        if (current()) setError(String(err));
      } finally {
        if (current()) setBusy(false);
      }
    },
    [latest],
  );

  return { input, error, setError, busy, pick, reset, update, run };
}
