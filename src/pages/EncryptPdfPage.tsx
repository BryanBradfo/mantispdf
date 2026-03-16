import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { PageSEO } from "../components/seo/PageSEO";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";

export default function EncryptPdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [encryptError, setEncryptError] = useState<string | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const [userPassword, setUserPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const handleFile = useCallback((f: File) => {
    const err = validatePdfFile(f);
    if (err) { setUploadError(err); return; }
    setUploadError(null);
    setEncryptError(null);
    setResult(null);
    setDownloaded(false);
    setFile(f);
  }, []);

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
      setEncryptError(String(err));
    }
  }, [file, userPassword, confirmPassword, ownerPassword, worker]);

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
        title="Encrypt PDF — MantisPDF"
        description="Password-protect your PDF so only authorized readers can open it. Client-side only, nothing is uploaded."
        path="/encrypt"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Encrypt PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Set a password to restrict who can open your PDF. Processed entirely in your browser.
      </p>

      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

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
                Password <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={userPassword}
                onChange={(e) => { setUserPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder="Enter password"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#141414] dark:text-[#ddd]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
                Confirm password <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordMismatch(false); }}
                placeholder="Re-enter password"
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 dark:bg-[#141414] dark:text-[#ddd] ${
                  passwordMismatch
                    ? "border-red-400 focus:border-red-400 focus:ring-red-400 dark:border-red-700"
                    : "border-gray-300 focus:border-mantis-500 focus:ring-mantis-500 dark:border-[#333]"
                }`}
              />
              {passwordMismatch && (
                <p className="mt-1 text-xs text-red-500">Passwords do not match.</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
                Owner password{" "}
                <span className="font-normal text-gray-400 dark:text-[#666]">(optional — restricts editing/printing)</span>
              </label>
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder="Leave blank to use the same password"
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
              Encrypt PDF
            </button>
            <button
              onClick={handleReset}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {worker.encrypting && (
        <div className="mt-12 flex flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
          <p className="text-gray-500 dark:text-[#555]">Encrypting…</p>
        </div>
      )}

      {result && (
        <div className="mt-8">
          <div className="rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]">
            <p className="font-medium text-gray-800 dark:text-[#ccc]">PDF encrypted successfully.</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-[#555]">
              Open the downloaded file in any PDF reader and it will prompt for your password.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={handleDownload}
                className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                Download encrypted PDF
              </button>
              {downloaded && (
                <Link
                  to="/"
                  className="rounded-lg border border-mantis-500 px-4 py-2.5 text-sm font-medium text-mantis-700 hover:bg-mantis-50 dark:border-mantis-600 dark:text-mantis-400 dark:hover:bg-mantis-950/20"
                >
                  ← All tools
                </Link>
              )}
              <button
                onClick={handleReset}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
              >
                Encrypt another
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
