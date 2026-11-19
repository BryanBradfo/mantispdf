import { useCallback, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import ToolShell from "./ToolShell";
import LoadingRow from "../components/common/LoadingRow";
import { fileMeta, inputClass, panelClass, primaryButton, secondaryButton } from "../styles/ui";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";

export default function EncryptPdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const t = useT("encrypt");
  const tc = useT("common");
  const describe = useDescribeError();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [encryptError, setEncryptError] = useState<UiError | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const [userPassword, setUserPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const handleFile = useCallback((f: File) => {
    if (!isPdfFile(f)) { setUploadError(tc("invalidPdf")); return; }
    setUploadError(null);
    setEncryptError(null);
    setResult(null);
    setDownloaded(false);
    setFile(f);
  }, [tc]);

  const handleApply = useCallback(async () => {
    if (!file) return;
    if (userPassword !== confirmPassword) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    setEncryptError(null);
    try {
      const buf = await worker.encryptPdf(
        file,
        userPassword,
        ownerPassword || userPassword,
      );
      setResult({
        bytes: new Uint8Array(buf),
        name: file.name.replace(/\.pdf$/i, "") + "_encrypted.pdf",
      });
    } catch (err) {
      setEncryptError(describe(err));
    }
  }, [file, userPassword, confirmPassword, ownerPassword, worker, describe]);

  const handleDownload = useCallback(() => {
    if (!result) return;
    downloadBlob(result.bytes, result.name);
    setDownloaded(true);
  }, [result]);

  const handleReset = useCallback(() => {
    setFile(null);
    setResult(null);
    setEncryptError(null);
    setDownloaded(false);
    setUserPassword("");
    setConfirmPassword("");
    setOwnerPassword("");
    setPasswordMismatch(false);
  }, []);

  return (
    <ToolShell
      tool="encrypt"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/encrypt"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !result && !worker.encrypting && (
        <div className={`${panelClass} space-y-6`}>
          <p className={fileMeta}>{file.name}</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink">
                {t("password")} <span className="text-ink-2">*</span>
              </label>
              <input
                type="password"
                value={userPassword}
                onChange={(e) => { setUserPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder={t("passwordPlaceholder")}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink">
                {t("confirm")} <span className="text-ink-2">*</span>
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder={t("confirmPlaceholder")}
                aria-invalid={passwordMismatch}
                className={`${inputClass} ${passwordMismatch ? "!border-danger" : ""}`}
              />
              {passwordMismatch && (
                <p className="mt-1.5 text-xs text-danger">{t("mismatch")}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-ink">
                {t("owner")}{" "}
                <span className="font-normal text-ink-3">{t("ownerHint")}</span>
              </label>
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder={t("ownerPlaceholder")}
                className={inputClass}
              />
            </div>
          </div>

          <ErrorAlert error={encryptError} />

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleApply}
              disabled={!worker.ready || !userPassword.trim()}
              className={`flex-1 ${primaryButton}`}
            >
              {t("submit")}
            </button>
            <button
              onClick={handleReset}
              className={secondaryButton}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {worker.encrypting && (
        <LoadingRow label={t("encrypting")} className="mt-12 justify-center" />
      )}

      {result && (
        <div className="mt-8">
          <div className={`${panelClass} !mt-0`}>
            <p className="font-medium text-ink">{t("done")}</p>
            <p className="mt-1 text-sm text-ink-2">
              {t("doneHint")}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={handleDownload}
                className={`flex-1 ${primaryButton}`}
              >
                {t("download")}
              </button>
              {downloaded && (
                <Link
                  to="/"
                  className={secondaryButton}
                >
                  {tc("allTools")}
                </Link>
              )}
              <button
                onClick={handleReset}
                className={secondaryButton}
              >
                {t("another")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToolShell>
  );
}
