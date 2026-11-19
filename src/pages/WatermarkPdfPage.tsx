import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import { Document, Page } from "../lib/pdf";
import ToolShell from "./ToolShell";
import LoadingRow from "../components/common/LoadingRow";
import ToggleChip from "../components/common/ToggleChip";
import { fileMeta, focusRing, inputClass, monoLabel, panelClass, primaryButton, secondaryButton } from "../styles/ui";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";

const COLOR_PRESETS = [
  { id: "gray", r: 0.5, g: 0.5, b: 0.5 },
  { id: "black", r: 0, g: 0, b: 0 },
  { id: "red", r: 0.8, g: 0.08, b: 0.08 },
  { id: "blue", r: 0.08, g: 0.27, b: 0.8 },
] as const;

export default function WatermarkPdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const t = useT("watermark");
  const tc = useT("common");
  const describe = useDescribeError();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [watermarkError, setWatermarkError] = useState<UiError | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [previewPageCount, setPreviewPageCount] = useState(0);

  const previewUrl = useMemo(
    () =>
      result
        ? URL.createObjectURL(new Blob([result.bytes], { type: "application/pdf" }))
        : null,
    [result],
  );

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // The default text is printed on the page, so it follows the UI language.
  const [text, setText] = useState(() => t("defaultText"));
  const [opacity, setOpacity] = useState(30);
  const [fontSize, setFontSize] = useState(60);
  const [angle, setAngle] = useState(45);
  const [colorIdx, setColorIdx] = useState(0);

  const handleFile = useCallback((f: File) => {
    if (!isPdfFile(f)) { setUploadError(tc("invalidPdf")); return; }
    setUploadError(null);
    setWatermarkError(null);
    setResult(null);
    setDownloaded(false);
    setFile(f);
  }, [tc]);

  const handleApply = useCallback(async () => {
    if (!file) return;
    setWatermarkError(null);
    const preset = COLOR_PRESETS[colorIdx];
    try {
      const buf = await worker.watermarkPdf(
        file, text.trim() || t("fallbackText"), fontSize, opacity / 100, angle,
        preset.r, preset.g, preset.b,
      );
      setResult({
        bytes: new Uint8Array(buf),
        name: file.name.replace(/\.pdf$/i, "") + "_watermarked.pdf",
      });
    } catch (err) {
      setWatermarkError(describe(err));
    }
  }, [file, text, fontSize, opacity, angle, colorIdx, worker, t, describe]);

  const handleDownload = useCallback(() => {
    if (!result) return;
    downloadBlob(result.bytes, result.name);
    setDownloaded(true);
  }, [result]);

  const handleReset = useCallback(() => {
    setFile(null);
    setResult(null);
    setWatermarkError(null);
    setDownloaded(false);
    setPreviewPageCount(0);
  }, []);

  return (
    <ToolShell
      tool="watermark"
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/watermark"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !result && !worker.watermarking && (
        <div className={`${panelClass} space-y-6`}>
          <p className={fileMeta}>{file.name}</p>

          <div>
            <label className="block text-sm font-medium text-ink">
              {t("text")}
            </label>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("defaultText")}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SliderField label={t("opacity")} value={opacity} min={5} max={100} shown={t("percent", { value: opacity })} onChange={setOpacity} />
            <SliderField label={t("fontSize")} value={fontSize} min={20} max={120} shown={t("points", { value: fontSize })} onChange={setFontSize} />
            <SliderField label={t("angle")} value={angle} min={0} max={180} shown={t("degrees", { value: angle })} onChange={setAngle} />
          </div>

          <div>
            <p className="text-sm font-medium text-ink">{t("color")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {COLOR_PRESETS.map((preset, idx) => (
                <ToggleChip key={preset.id} on={colorIdx === idx} onClick={() => setColorIdx(idx)}>
                  {t(preset.id)}
                </ToggleChip>
              ))}
            </div>
          </div>

          <ErrorAlert error={watermarkError} />

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleApply}
              disabled={!worker.ready || !text.trim()}
              className={`flex-1 ${primaryButton}`}
            >
              {t("apply")}
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

      {worker.watermarking && (
        <LoadingRow label={t("adding")} className="mt-12 justify-center" />
      )}

      {result && previewUrl && (
        <div className="mt-8 space-y-4">
          <div className="overflow-hidden border border-line">
            <p className={`border-b border-line px-4 py-2 ${monoLabel}`}>
              {previewPageCount > 1 ? t("previewOf", { total: previewPageCount }) : t("previewFirst")}
            </p>
            <div className="flex justify-center bg-surface p-4">
              <Document
                file={previewUrl}
                onLoadSuccess={({ numPages }) => setPreviewPageCount(numPages)}
                loading={
                  <div className={`flex h-40 items-center justify-center ${monoLabel}`}>
                    {t("rendering")}
                  </div>
                }
              >
                <Page pageNumber={1} width={440} renderTextLayer={false} renderAnnotationLayer={false} />
              </Document>
            </div>
          </div>

          <div className={`${panelClass} !mt-0`}>
            <p className="font-medium text-ink">{t("done")}</p>
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

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** The value as shown, with its unit ("30%", "60pt"). */
  shown: string;
  onChange: (v: number) => void;
}

function SliderField({ label, value, min, max, shown, onChange }: SliderFieldProps) {
  return (
    <div>
      <div className="flex justify-between">
        <label className="text-sm font-medium text-ink">{label}</label>
        <span className="font-mono text-xs text-ink-2">{shown}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`mt-2 w-full ${focusRing}`}
      />
    </div>
  );
}
