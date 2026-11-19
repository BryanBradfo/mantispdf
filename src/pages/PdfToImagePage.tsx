import { useCallback, useState } from "react";
import { Link, useT } from "../i18n";
import { downloadBlobsAsZip } from "../lib/downloadZip";
import ToolShell from "./ToolShell";
import { chipClass, monoLabel, panelClass, primaryButton, secondaryButton } from "../styles/ui";
import { isPdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ProgressOverlay from "../components/common/ProgressOverlay";
import { usePdfToImage, type ImageFormat, type RenderScale } from "../hooks/usePdfToImage";

export default function PdfToImagePage() {
  const t = useT("pdfToImage");
  const tc = useT("common");
  const { converting, error, setError, convertPdfToImages } = usePdfToImage();
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [format, setFormat] = useState<ImageFormat>("png");
  const [scale, setScale] = useState<RenderScale>(2);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleFile = useCallback((f: File) => {
    if (!isPdfFile(f)) {
      setUploadError(tc("invalidPdf"));
      return;
    }
    setUploadError(null);
    setFile(f);
    setDownloaded(false);
  }, [tc]);

  const handleConvert = useCallback(async () => {
    if (!file) return;
    setProgress(null);

    try {
      const parts = await convertPdfToImages(file, {
        format,
        scale,
        onProgress: (current, total) => setProgress({ current, total }),
      });

      if (parts.length === 1) {
        const bytes = new Uint8Array(await parts[0].blob.arrayBuffer());
        downloadBlob(bytes, parts[0].name);
      } else {
        const baseName = file.name.replace(/\.pdf$/i, "");
        await downloadBlobsAsZip(parts, `${baseName}_images.zip`);
      }

      setDownloaded(true);
    } catch {
      // error is set by the hook
    }
  }, [file, format, scale, convertPdfToImages]);

  const handleReset = useCallback(() => {
    setFile(null);
    setProgress(null);
    setDownloaded(false);
    setError(null);
  }, [setError]);

  const scaleOptions: { value: RenderScale; label: string }[] = ([1, 2, 3, 4, 5] as const).map((value) => ({
    value,
    label: t("scale", { scale: value, dpi: value * 72 }),
  }));

  return (
    <ToolShell
      tool="pdfToImage"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/pdf-to-image"
      heading={t("heading")}
      intro={t("intro")}
    >
      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !converting && (
        <div className={`${panelClass} space-y-6`}>
          <div>
            <p className={monoLabel}>{t("selectedFile")}</p>
            <p className="mt-1.5 truncate text-sm text-ink">{file.name}</p>
          </div>

          <div>
            <p className={`mb-2 ${monoLabel}`}>{t("format")}</p>
            <div className="flex flex-wrap gap-2">
              {(["png", "jpeg"] as ImageFormat[]).map((f) => (
                <button key={f} onClick={() => setFormat(f)} aria-pressed={format === f} className={chipClass(format === f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className={`mb-2 ${monoLabel}`}>{t("resolution")}</p>
            <div className="flex flex-wrap gap-2">
              {scaleOptions.map(({ value, label }) => (
                <button key={value} onClick={() => setScale(value)} aria-pressed={scale === value} className={chipClass(scale === value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 border-t border-line pt-6">
            <button onClick={handleConvert} className={`flex-1 ${primaryButton}`}>
              {t("convert")}
            </button>
            {downloaded && (
              <Link to="/" className={secondaryButton}>
                {tc("allTools")}
              </Link>
            )}
            <button onClick={handleReset} className={secondaryButton}>
              {tc("reset")}
            </button>
          </div>
        </div>
      )}

      {converting && (
        <ProgressOverlay
          progress={progress ? progress.current / progress.total : 0}
          message={t("converting", { page: (progress?.current ?? 0) + 1, total: progress?.total ?? "…" })}
          error={error}
          onDismissError={() => { setError(null); }}
        />
      )}
    </ToolShell>
  );
}
