import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import JSZip from "jszip";
import { PageSEO } from "../components/seo/PageSEO";
import { validatePdfFile, downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ProgressOverlay from "../components/common/ProgressOverlay";
import { usePdfToImage, type ImageFormat, type RenderScale } from "../hooks/usePdfToImage";

export default function PdfToImagePage() {
  const { converting, error, setError, convertPdfToImages } = usePdfToImage();
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [format, setFormat] = useState<ImageFormat>("png");
  const [scale, setScale] = useState<RenderScale>(2);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleFile = useCallback((f: File) => {
    const validationError = validatePdfFile(f);
    if (validationError) {
      setUploadError(validationError);
      return;
    }
    setUploadError(null);
    setFile(f);
    setDownloaded(false);
  }, []);

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
        const zip = new JSZip();
        parts.forEach((p) => zip.file(p.name, p.blob));
        const baseName = file.name.replace(/\.pdf$/i, "");
        const zipBytes = new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
        downloadBlob(zipBytes, `${baseName}_images.zip`);
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

  const scaleOptions: { value: RenderScale; label: string }[] = [
    { value: 1, label: "1× (72 dpi)" },
    { value: 2, label: "2× (144 dpi)" },
    { value: 3, label: "3× (216 dpi)" },
    { value: 4, label: "4× (288 dpi)" },
    { value: 5, label: "5× (360 dpi)" },
  ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageSEO
        title="PDF to Images — Export PDF Pages as PNG or JPEG — MantisPDF"
        description="Convert each PDF page to a PNG or JPEG image. No upload, no data sent to any server."
        path="/pdf-to-image"
      />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">PDF to Images</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">
        Export each page of your PDF as a PNG or JPEG image — all processing happens locally in your browser.
      </p>

      {!file && (
        <div className="mt-8">
          <DropZone onFile={handleFile} error={uploadError} />
        </div>
      )}

      {file && !converting && (
        <div className="mt-8 space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-[#222] dark:bg-[#0c0c0c]">
            <p className="mb-1 text-sm font-medium text-gray-700 dark:text-[#aaa]">Selected file</p>
            <p className="truncate text-sm text-gray-500 dark:text-[#555]">{file.name}</p>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-700 dark:text-[#aaa]">Format</p>
            <div className="flex gap-2">
              {(["png", "jpeg"] as ImageFormat[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    format === f
                      ? "bg-mantis-600 text-white"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
                  }`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-700 dark:text-[#aaa]">Resolution</p>
            <div className="flex gap-2">
              {scaleOptions.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setScale(value)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    scale === value
                      ? "bg-mantis-600 text-white"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleConvert}
              className="flex-1 rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2"
            >
              Convert to images
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
              Reset
            </button>
          </div>
        </div>
      )}

      {converting && (
        <ProgressOverlay
          progress={progress ? progress.current / progress.total : 0}
          message={`Converting page ${(progress?.current ?? 0) + 1} of ${progress?.total ?? "…"}…`}
          error={error}
          onDismissError={() => { setError(null); }}
        />
      )}
    </div>
  );
}
