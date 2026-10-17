import { useState } from "react";
import { usePdfWorker, type SanitizeReport } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

export default function SanitizePdfPage() {
  const worker = usePdfWorker();
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker);
  const [keepComments, setKeepComments] = useState(false);
  const [summary, setSummary] = useState<{ report: SanitizeReport; keptComments: boolean } | null>(null);

  const sanitize = () => {
    if (!input) return;
    const keep = keepComments;
    void run(
      () => worker.sanitizePdf(input.bytes, keep),
      (out) => {
        setSummary({ report: out.report, keptComments: keep });
        downloadBlob(out.bytes, `${baseName(input.file)}_clean.pdf`);
      },
    );
  };
  const choose = (f: File) => {
    setSummary(null);
    void pick(f);
  };

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
          <DropZone onFile={choose} error={error} />
        </div>
      )}

      {input && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
            <input
              type="checkbox"
              checked={keepComments}
              onChange={(e) => {
                setKeepComments(e.target.checked);
                setSummary(null);
              }}
            />
            Keep comments
          </label>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button onClick={sanitize} disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? "Sanitizing…" : "Sanitize and download"}
            </button>
            <button onClick={() => { reset(); setSummary(null); }} className={secondaryButton}>
              Choose another file
            </button>
          </div>
          {summary && (
            <ul className="mt-6 space-y-1 text-sm text-gray-700 dark:text-[#aaa]">
              <li>Fields flattened: {summary.report.fieldsFlattened}</li>
              <li>Links kept: {summary.report.linksKept}</li>
              <li>Links removed: {summary.report.linksDropped}</li>
              <li>
                {summary.keptComments ? "Comments kept" : "Comments removed"}:{" "}
                {summary.keptComments ? summary.report.commentsKept : summary.report.commentsDropped}
              </li>
              {summary.report.warnings > 0 && (
                <li>Some pages could not be fully analysed and kept all their resources.</li>
              )}
            </ul>
          )}
        </div>
      )}
    </ToolShell>
  );
}
