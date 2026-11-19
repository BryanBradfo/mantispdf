import { useCallback, useState } from "react";
import { Link, formatBytes, formatNumber, useDescribeError, useLocale, useT, type UiError } from "../i18n";
import { ArrowRight } from "lucide-react";
import ToolShell from "./ToolShell";
import LoadingRow from "../components/common/LoadingRow";
import { monoLabel, panelClass, primaryButton, secondaryButton } from "../styles/ui";
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
    <ToolShell
      tool="compress"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/compress"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!result && !worker.compressing && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {worker.compressing && <LoadingRow label={t("compressing")} className="mt-12 justify-center" />}

      <ErrorAlert error={compressError} onDismiss={() => setCompressError(null)} className="mt-6" />

      {result && (
        <div className={panelClass}>
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-4 sm:grid-cols-[1fr_auto_1fr_auto]">
            <div>
              <p className={monoLabel}>{t("original")}</p>
              <p className="mt-2 font-display text-2xl font-light text-ink">
                {formatBytes(result.originalSize, locale)}
              </p>
            </div>
            <ArrowRight aria-hidden="true" strokeWidth={1.5} className="mb-1.5 h-5 w-5 text-ink-2" />
            <div>
              <p className={monoLabel}>{t("compressed")}</p>
              <p className="mt-2 font-display text-2xl font-light text-ink">
                {formatBytes(result.compressedSize, locale)}
              </p>
            </div>
            <div className="col-span-3 border-t border-line pt-4 sm:col-span-1 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
              <p className="font-display text-3xl font-normal text-ink">
                {savings > 0
                  ? t("savedLess", { percent: formatNumber(savings / 100, locale, { style: "percent" }) })
                  : savings < 0
                    ? t("savedMore", { percent: formatNumber(-savings / 100, locale, { style: "percent" }) })
                    : t("savedNone")}
              </p>
              <p className={`mt-1 ${monoLabel}`}>
                {savings > 0 ? t("smaller") : savings < 0 ? t("larger") : t("noChange")}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={handleDownload} className={`flex-1 ${primaryButton}`}>
              {t("download")}
            </button>
            {downloaded && (
              <Link to="/" className={secondaryButton}>
                {tc("allTools")}
              </Link>
            )}
            <button
              onClick={() => { setResult(null); setDownloaded(false); }}
              className={secondaryButton}
            >
              {t("another")}
            </button>
          </div>
        </div>
      )}
    </ToolShell>
  );
}
