import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName } from "./usePdfInput";
import { METADATA_FIELDS, useMetadataInput } from "./useMetadataInput";
import { useT } from "../i18n";

export default function EditMetadataPage() {
  const t = useT("editMetadata");
  const tm = useT("metadata");
  const tc = useT("common");
  const { worker, input, error, setError, busy, pick, reset, update, run } = useMetadataInput();

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/edit-metadata"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={(f) => void pick(f)} error={error} />
        </div>
      )}

      {input && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <div className="mt-4 space-y-3">
            {METADATA_FIELDS.map((key) => (
              <label key={key} className="block text-sm text-gray-700 dark:text-[#aaa]">
                {tm(key)}
                <input
                  type="text"
                  value={input.data[key]}
                  onChange={(e) => update({ ...input.data, [key]: e.target.value })}
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-[#555]">{t("emptyHint")}</p>
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button
              onClick={() =>
                void run(
                  () => worker.setMetadata(input.bytes, input.data),
                  (out) => downloadBlob(out, `${baseName(input.file)}_edited.pdf`),
                )
              }
              disabled={busy}
              className={`flex-1 ${primaryButton}`}
            >
              {busy ? t("saving") : t("submit")}
            </button>
            <button onClick={reset} className={secondaryButton}>
              {tc("chooseAnother")}
            </button>
          </div>
        </div>
      )}
    </ToolShell>
  );
}
