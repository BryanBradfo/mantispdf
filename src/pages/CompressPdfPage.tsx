import { useCallback, useState } from "react";
import { Link, formatBytes, formatNumber, useDescribeError, useLocale, useT, type UiError } from "../i18n";
import { PageSEO } from "../components/seo/PageSEO";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";

interface CompressionResult {
  originalSize: number;
  compressedSize: number;
  bytes: Uint8Array;
  fileName: string;
}

export default function CompressPdfPage() {
  const worker = usePdfWorker();
  const t = useT("compress");
  const tc = useT("common");
  const locale = useLocale();
  const describe = useDescribeError();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [compressError, setCompressError] = useState<UiError | null>(null);
  const [result, setResult] = useState<CompressionResult | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!isPdfFile(file)) {
        setUploadError(tc("invalidPdf"));
        return;
      }
      setUploadError(null);
      setCompressError(null);
      setResult(null);

      try {
        const compressed = await worker.compressPdf(file);
        setResult({
          originalSize: file.size,
          compressedSize: compressed.byteLength,
          bytes: new Uint8Array(compressed),
          fileName: file.name.replace(/\.pdf$/i, "") + "_compressed.pdf",
        });
      } catch (err) {
        setCompressError(describe(err));
      }
    },
    [worker, tc, describe],
  );

  const handleDownload = useCallback(() => {
    if (!result) return;
    downloadBlob(result.bytes, result.fileName);
    setDownloaded(true);
  }, [result]);

  const savings = result
    ? Math.round(((result.originalSize - result.compressedSize) / result.originalSize) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageSEO
        title={t("seoTitle")}
        description={t("seoDescription")}
        path="/compress"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{t("heading")}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        {t("intro")}
      </p>

      <ErrorAlert error={worker.initError ? tc("engineFailed", { error: worker.initError }) : null} className="mt-4" />

      {!result && !worker.compressing && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {worker.compressing && (
        <div className="mt-12 flex flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
          <p className="text-gray-500 dark:text-[#555]">{t("compressing")}</p>
        </div>
      )}

      <ErrorAlert error={compressError} onDismiss={() => setCompressError(null)} className="mt-6" />

      {result && (
        <div className="mt-8 rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <p className="text-sm text-gray-500 dark:text-[#555]">{t("original")}</p>
              <p className="text-xl font-semibold text-gray-800 dark:text-[#ccc]">
                {formatBytes(result.originalSize, locale)}
              </p>
            </div>
            <div className="text-2xl text-mantis-500">→</div>
            <div className="flex-1">
              <p className="text-sm text-gray-500 dark:text-[#555]">{t("compressed")}</p>
              <p className="text-xl font-semibold text-gray-800 dark:text-[#ccc]">
                {formatBytes(result.compressedSize, locale)}
              </p>
            </div>
            <div className="rounded-lg bg-mantis-100 px-3 py-2 text-center dark:bg-mantis-900/40">
              <p className="text-2xl font-bold text-mantis-700 dark:text-mantis-400">
                {savings > 0
                  ? t("savedLess", { percent: formatNumber(savings / 100, locale, { style: "percent" }) })
                  : savings < 0
                    ? t("savedMore", { percent: formatNumber(-savings / 100, locale, { style: "percent" }) })
                    : t("savedNone")}
              </p>
              <p className="text-xs text-mantis-600 dark:text-mantis-500">
                {savings > 0 ? t("smaller") : savings < 0 ? t("larger") : t("noChange")}
              </p>
            </div>
          </div>

          <div className="mt-6 flex gap-3">
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
              onClick={() => { setResult(null); setDownloaded(false); }}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
            >
              {t("another")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
