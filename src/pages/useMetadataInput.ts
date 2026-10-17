import { useCallback } from "react";
import { usePdfWorker, type PdfMetadata } from "../hooks/usePdfWorker";
import { usePdfInput } from "./usePdfInput";

export const METADATA_FIELDS: [keyof PdfMetadata, string][] = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
];

/** A single PDF whose metadata is read atomically with its bytes. */
export function useMetadataInput() {
  const worker = usePdfWorker();
  const prepare = useCallback((bytes: Uint8Array) => worker.readMetadata(bytes), [worker]);
  return { worker, ...usePdfInput<PdfMetadata>(worker, prepare) };
}
