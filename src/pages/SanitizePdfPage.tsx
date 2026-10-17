import { useCallback, useState } from "react";
import { usePdfWorker, type SanitizeReport } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

export default function SanitizePdfPage() {
  const worker = usePdfWorker();
  const { input, error, setError, pick, reset } = usePdfInput(worker);
  const [keepComments, setKeepComments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SanitizeReport | null>(null);

  const run = useCallback(async () => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const out = await worker.sanitizePdf(input.bytes, keepComments);
      setReport(out.report);
      downloadBlob(out.bytes, `${baseName(input.file)}_clean.pdf`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, keepComments, worker, setError]);

  return (
    <ToolShell
      title="Sanitize PDF | MantisPDF"
      description="Strip hidden data from a PDF: metadata, scripts, attachments, form data and hidden content from removed pages. Free, private, nothing is uploaded."
      path="/sanitize"
      heading="Sanitize PDF"
      intro="Strip hidden data from a PDF: metadata, scripts, attachments, form data and hidden content from removed pages."
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
          <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
            <input
              type="checkbox"
              checked={keepComments}
              onChange={(e) => setKeepComments(e.target.checked)}
            />
            Keep comments
          </label>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button onClick={() => void run()} disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? "Sanitizing…" : "Sanitize and download"}
            </button>
            <button onClick={() => { reset(); setReport(null); }} className={secondaryButton}>
              Choose another file
            </button>
          </div>
          {report && (
            <ul className="mt-6 space-y-1 text-sm text-gray-700 dark:text-[#aaa]">
              <li>Fields flattened: {report.fieldsFlattened}</li>
              <li>Links kept: {report.linksKept}</li>
              <li>Links removed: {report.linksDropped}</li>
              <li>
                {keepComments ? "Comments kept" : "Comments removed"}:{" "}
                {keepComments ? report.commentsKept : report.commentsDropped}
              </li>
              {report.warnings > 0 && (
                <li>Some pages could not be fully analysed and kept all their resources.</li>
              )}
            </ul>
          )}
        </div>
      )}
    </ToolShell>
  );
}
