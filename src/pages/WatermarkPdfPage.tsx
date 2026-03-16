import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Document, Page } from "react-pdf";
import { PageSEO } from "../components/seo/PageSEO";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { validatePdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";

const COLOR_PRESETS = [
  { label: "Gray", r: 0.5, g: 0.5, b: 0.5 },
  { label: "Black", r: 0, g: 0, b: 0 },
  { label: "Red", r: 0.8, g: 0.08, b: 0.08 },
  { label: "Blue", r: 0.08, g: 0.27, b: 0.8 },
] as const;

export default function WatermarkPdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [watermarkError, setWatermarkError] = useState<string | null>(null);
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

  const [text, setText] = useState("CONFIDENTIAL");
  const [opacity, setOpacity] = useState(30);
  const [fontSize, setFontSize] = useState(60);
  const [angle, setAngle] = useState(45);
  const [colorIdx, setColorIdx] = useState(0);

  const handleFile = useCallback((f: File) => {
    const err = validatePdfFile(f);
    if (err) { setUploadError(err); return; }
    setUploadError(null);
    setWatermarkError(null);
    setResult(null);
    setDownloaded(false);
    setFile(f);
  }, []);

  const handleApply = useCallback(async () => {
    if (!file) return;
    setWatermarkError(null);
    const preset = COLOR_PRESETS[colorIdx];
    try {
      const buf = await worker.watermarkPdf(
        file, text.trim() || "WATERMARK", fontSize, opacity / 100, angle,
        preset.r, preset.g, preset.b,
      );
      setResult({
        bytes: new Uint8Array(buf),
        name: file.name.replace(/\.pdf$/i, "") + "_watermarked.pdf",
      });
    } catch (err) {
      setWatermarkError(String(err));
    }
  }, [file, text, fontSize, opacity, angle, colorIdx, worker]);

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
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageSEO
        title="Watermark PDF — MantisPDF"
        description="Add a diagonal text watermark to every page of your PDF. Client-side only, nothing is uploaded."
        path="/watermark"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">Watermark PDF</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Stamp text on every page — CONFIDENTIAL, DRAFT, or any label. Processed entirely in your browser.
      </p>

      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !result && !worker.watermarking && (
        <div className="mt-8 space-y-6">
          <p className="text-sm text-gray-500 dark:text-[#555]">{file.name}</p>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">
              Watermark text
            </label>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="CONFIDENTIAL"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#141414] dark:text-[#ddd]"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SliderField label="Opacity" value={opacity} min={5} max={100} unit="%" onChange={setOpacity} />
            <SliderField label="Font size" value={fontSize} min={20} max={120} unit="pt" onChange={setFontSize} />
            <SliderField label="Angle" value={angle} min={0} max={180} unit="°" onChange={setAngle} />
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-[#aaa]">Color</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {COLOR_PRESETS.map((preset, idx) => (
                <button
                  key={preset.label}
                  onClick={() => setColorIdx(idx)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                    colorIdx === idx
                      ? "border-mantis-500 bg-mantis-50 text-mantis-700 dark:border-mantis-600 dark:bg-mantis-950/30 dark:text-mantis-400"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <ErrorAlert error={watermarkError} />

          <div className="flex gap-3">
            <button
              onClick={handleApply}
              disabled={!worker.ready || !text.trim()}
              className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
            >
              Add Watermark
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

      {worker.watermarking && (
        <div className="mt-12 flex flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-mantis-300 border-t-transparent" />
          <p className="text-gray-500 dark:text-[#555]">Adding watermark…</p>
        </div>
      )}

      {result && previewUrl && (
        <div className="mt-8 space-y-4">
          <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a]">
            <p className="border-b border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-[#2a2a2a] dark:text-[#555]">
              Preview — page 1{previewPageCount > 1 ? ` of ${previewPageCount}` : ""}
            </p>
            <div className="flex justify-center bg-gray-100 p-4 dark:bg-[#111]">
              <Document
                file={previewUrl}
                onLoadSuccess={({ numPages }) => setPreviewPageCount(numPages)}
                loading={
                  <div className="flex h-40 items-center justify-center text-sm text-gray-400">
                    Rendering…
                  </div>
                }
              >
                <Page pageNumber={1} width={440} renderTextLayer={false} renderAnnotationLayer={false} />
              </Document>
            </div>
          </div>

          <div className="rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]">
            <p className="font-medium text-gray-800 dark:text-[#ccc]">Watermark added successfully.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={handleDownload}
                className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
              >
                Download watermarked PDF
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
                Watermark another
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}

function SliderField({ label, value, min, max, unit, onChange }: SliderFieldProps) {
  return (
    <div>
      <div className="flex justify-between">
        <label className="text-sm font-medium text-gray-700 dark:text-[#aaa]">{label}</label>
        <span className="text-sm text-gray-500 dark:text-[#555]">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-mantis-600"
      />
    </div>
  );
}
