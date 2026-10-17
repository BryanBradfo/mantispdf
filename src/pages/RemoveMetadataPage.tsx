import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName } from "./usePdfInput";
import { METADATA_FIELDS, useMetadataInput } from "./useMetadataInput";

export default function RemoveMetadataPage() {
  const { worker, input, error, setError, busy, pick, reset, run } = useMetadataInput();

  return (
    <ToolShell
      title="Remove PDF Metadata | MantisPDF"
      description="Remove the title, author, subject and keywords from a PDF. Free, private, nothing is uploaded."
      path="/remove-metadata"
      heading="Remove Metadata"
      intro="Remove the title, author, subject and keywords stored inside a PDF."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => void pick(f)} error={error} />
        </div>
      )}

      {input && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <dl className="mt-4 space-y-2 text-sm">
            {METADATA_FIELDS.map(([key, label]) => (
              <div key={key} className="flex gap-3">
                <dt className="w-24 shrink-0 text-gray-500 dark:text-[#555]">{label}</dt>
                <dd className="min-w-0 break-words text-gray-800 dark:text-[#ccc]">{input.data[key] || "(empty)"}</dd>
              </div>
            ))}
          </dl>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button
              onClick={() =>
                void run(
                  () => worker.removeMetadata(input.bytes),
                  (out) => downloadBlob(out, `${baseName(input.file)}_nometa.pdf`),
                )
              }
              disabled={busy}
              className={`flex-1 ${primaryButton}`}
            >
              {busy ? "Working…" : "Remove metadata and download"}
            </button>
            <button onClick={reset} className={secondaryButton}>
              Choose another file
            </button>
          </div>
        </div>
      )}
    </ToolShell>
  );
}
