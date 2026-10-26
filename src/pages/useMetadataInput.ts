import { useCallback } from "react";
import { usePdfWorker, type PdfMetadata } from "../hooks/usePdfWorker";
import { usePdfInput } from "./usePdfInput";

/** The four fields, in display order; each key is also its `metadata` label key. */
export const METADATA_FIELDS: readonly (keyof PdfMetadata)[] = ["title", "author", "subject", "keywords"];

/** A single PDF whose metadata is read atomically with its bytes. */
export function useMetadataInput() {
  const worker = usePdfWorker();
  const prepare = useCallback((bytes: Uint8Array) => worker.readMetadata(bytes), [worker]);
  return { worker, ...usePdfInput<PdfMetadata>(worker, prepare) };
}
