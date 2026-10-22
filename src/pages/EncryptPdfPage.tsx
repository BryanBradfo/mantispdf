import { useCallback, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import { PageSEO } from "../components/seo/PageSEO";
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
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription")}
        path="/encrypt"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("intro")}
      </p>

      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !result && !worker.encrypting && (
        <div className="mt-8 space-y-6">
          <p className="text-sm text-gray-500 dark:text-[#555]">{file.name}</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
                {t("password")} <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={userPassword}
                onChange={(e) => { setUserPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder={t("passwordPlaceholder")}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#141414] dark:text-[#ddd]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
                {t("confirm")} <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder={t("confirmPlaceholder")}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 dark:bg-[#141414] dark:text-[#ddd] ${
                  passwordMismatch
                    ? "border-red-400 focus:border-red-400 focus:ring-red-400 dark:border-red-700"
                    : "border-gray-300 focus:border-mantis-500 focus:ring-mantis-500 dark:border-[#333]"
                }`}
              />
              {passwordMismatch && (
                <p className="mt-1 text-xs text-red-500">{t("mismatch")}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
                {t("owner")}{" "}
                <span className="font-normal text-gray-400 dark:text-[#666]">{t("ownerHint")}</span>
              </label>
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder={t("ownerPlaceholder")}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#141414] dark:text-[#ddd]"
              />
            </div>
          </div>

          <ErrorAlert error={encryptError} />

          <div className="flex gap-3">
            <button
              onClick={handleApply}
              disabled={!worker.ready || !userPassword.trim()}
              className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
            >
              {t("submit")}
            </button>
            <button
              onClick={handleReset}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {worker.encrypting && (
        <div className="mt-12 flex flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
          <p className="text-gray-500 dark:text-[#555]">{t("encrypting")}</p>
        </div>
      )}

      {result && (
        <div className="mt-8">
          <div className="rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]">
            <p className="font-medium text-gray-800 dark:text-[#ccc]">{t("done")}</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-[#555]">
              {t("doneHint")}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={handleDownload}
                className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                {t("download")}
              </button>
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-4 py-2.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  {tc("allTools")}
                </Link>
              )}
              <button
                onClick={handleReset}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                {t("another")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
