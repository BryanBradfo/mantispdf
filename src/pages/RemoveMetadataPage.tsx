import { useCallback, useState } from "react";
import { usePdfWorker, type PdfMetadata } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

const FIELDS: [keyof PdfMetadata, string][] = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
];

export default function RemoveMetadataPage() {
  const worker = usePdfWorker();
  const { input, error, setError, pick, reset } = usePdfInput(worker);
  const [meta, setMeta] = useState<PdfMetadata | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      const picked = await pick(file);
      if (!picked) return;
      try {
        setMeta(await worker.readMetadata(picked.bytes));
      } catch (err) {
        setError(String(err));
        reset();
      }
    },
    [pick, worker, setError, reset],
  );

  const run = useCallback(async () => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      downloadBlob(await worker.removeMetadata(input.bytes), `${baseName(input.file)}_nometa.pdf`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, worker, setError]);

  return (
    <ToolShell
      title="Remove PDF Metadata | MantisPDF"
      description="Remove the title, author, subject and keywords from a PDF. Free, private, nothing is uploaded."
      path="/remove-metadata"
      heading="Remove Metadata"
      intro="Remove the title, author, subject and keywords stored inside a PDF."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!(input && meta) && (
        <div className="mt-8">
          <DropZone onFile={(f) => void handleFile(f)} error={error} />
        </div>
      )}

      {input && meta && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <dl className="mt-4 space-y-2 text-sm">
            {FIELDS.map(([key, label]) => (
              <div key={key} className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500 dark:text-[#555]">{label}</dt>
                <dd className="min-w-0 break-words text-gray-800 dark:text-[#ccc]">{meta[key] || "(empty)"}</dd>
              </div>
            ))}
          </dl>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button onClick={() => void run()} disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? "Working…" : "Remove metadata and download"}
            </button>
            <button onClick={() => { reset(); setMeta(null); }} className={secondaryButton}>
              Choose another file
            </button>
          </div>
        </div>
      )}
    </ToolShell>
  );
}
