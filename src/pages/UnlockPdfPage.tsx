import { useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";

export default function UnlockPdfPage() {
  const worker = usePdfWorker();
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker);
  const [password, setPassword] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || busy) return;
    void run(
      () => worker.unlockPdf(input.bytes, password),
      (out) => {
        downloadBlob(out, `${baseName(input.file)}_unlocked.pdf`);
        setPassword("");
      },
    );
  };

  return (
    <ToolShell
      title="Unlock PDF | MantisPDF"
      description="Remove the password and restrictions from a PDF you are allowed to open. Free, private, nothing is uploaded."
      path="/unlock"
      heading="Unlock PDF"
      intro="Remove the password and restrictions from a PDF you are allowed to open."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => { setPassword(""); void pick(f); }} error={error} />
        </div>
      )}

      {input && (
        <form className={panelClass} onSubmit={submit}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <label className="mt-4 block text-sm text-gray-700 dark:text-[#aaa]">
            Password (leave empty if the PDF opens without one)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className={inputClass}
            />
          </label>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? "Unlocking…" : "Unlock and download"}
            </button>
            <button type="button" onClick={() => { reset(); setPassword(""); }} className={secondaryButton}>
              Choose another file
            </button>
          </div>
        </form>
      )}
    </ToolShell>
  );
}
