import { useCallback, useState } from "react";
import { usePdfWorker, type PdfMetadata } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

const FIELDS: [keyof PdfMetadata, string][] = [
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
];

export default function EditMetadataPage() {
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
    if (!input || !meta) return;
    setBusy(true);
    setError(null);
    try {
      downloadBlob(await worker.setMetadata(input.bytes, meta), `${baseName(input.file)}_edited.pdf`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, meta, worker, setError]);

  return (
    <ToolShell
      title="Edit PDF Metadata | MantisPDF"
      description="Edit the title, author, subject and keywords of a PDF. Free, private, nothing is uploaded."
      path="/edit-metadata"
      heading="Edit Metadata"
      intro="Change the title, author, subject and keywords stored inside a PDF."
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
          <div className="mt-4 space-y-3">
            {FIELDS.map(([key, label]) => (
              <label key={key} className="block text-sm text-gray-700 dark:text-[#aaa]">
                {label}
                <input
                  type="text"
                  value={meta[key]}
                  onChange={(e) => setMeta({ ...meta, [key]: e.target.value })}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-[#555]">Leave a field empty to remove it.</p>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button onClick={() => void run()} disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? "Saving…" : "Save and download"}
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
