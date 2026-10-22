import { useState } from "react";
import { usePdfWorker, type SanitizeReport } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";
import { imagesCleanedNote, sanitizeWarnings } from "./sanitizeNotes";
import { useT } from "../i18n";

export default function SanitizePdfPage() {
  const t = useT("sanitize");
  const tc = useT("common");
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
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/sanitize"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

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
            {t("keepComments")}
          </label>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button onClick={sanitize} disabled={busy} className={`flex-1 ${primaryButton}`}>
              {busy ? t("sanitizing") : t("submit")}
            </button>
            <button onClick={() => { reset(); setSummary(null); }} className={secondaryButton}>
              {tc("chooseAnother")}
            </button>
          </div>
          {summary && (
            <ul className="mt-6 space-y-1 text-sm text-gray-700 dark:text-[#aaa]">
              <li>{t("fieldsFlattened", { count: summary.report.fieldsFlattened })}</li>
              <li>{t("linksKept", { count: summary.report.linksKept })}</li>
              <li>{t("linksRemoved", { count: summary.report.linksDropped })}</li>
              <li>
                {summary.keptComments
                  ? t("commentsKept", { count: summary.report.commentsKept })
                  : t("commentsRemoved", { count: summary.report.commentsDropped })}
              </li>
              {imagesCleanedNote(summary.report, t) && <li>{imagesCleanedNote(summary.report, t)}</li>}
              {sanitizeWarnings(summary.report, t).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ToolShell>
  );
}
